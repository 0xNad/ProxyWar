import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  OWNER_EVIDENCE_MAX_EVENTS_BY_KIND,
  OWNER_EVIDENCE_SATURATION_KIND,
} from "./owner-capabilities.mjs";

const PREFIX = "PROXYWAR_OWNER_CAPABILITY_EVIDENCE ";
const MAX_LINE_BYTES = 8 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 25;
const MAX_REPLAY_MESSAGES = 25 * 600;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/u;
const MESSAGE_EVENT_ID =
  /^msg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;
const ALLOWED_KINDS = new Set([
  "deal_selection",
  "message_selection",
  "message_observation",
  "spatial_observation",
  OWNER_EVIDENCE_SATURATION_KIND,
]);
const FORBIDDEN_KEYS = new Set([
  "messagetext",
  "messagebody",
  "prompt",
  "provideroutput",
  "rawresponse",
  "authorization",
  "token",
  "secret",
]);
const COMMON_KEYS = [
  "kind",
  "requestID",
  "slot",
  "ownPlayerID",
  "selectedLegalActionID",
  "selectedLegalActionOffered",
];
const USAGE =
  "usage: node owner-evidence-check.mjs --deals=required|optional --messages=required|optional --spatial=absent|present|rich-v3|rich-v3-minimap|rich-v5|rich-v5-minimap|either [--replay=REPLAY] LOG [LOG ...]";
const ALLOWED_KEYS = new Map([
  [
    "deal_selection",
    new Set([...COMMON_KEYS, "offeredDealActionIDs", "selectedDealActionID"]),
  ],
  [
    "message_selection",
    new Set([
      ...COMMON_KEYS,
      "offeredMessageActionIDs",
      "selectedMessageActionID",
      "selectedMessageRecipientID",
      "messageBodySHA256",
      "messageBodyUTF8Bytes",
      "messageBodyUTF16CodeUnits",
    ]),
  ],
  [
    "message_observation",
    new Set([
      ...COMMON_KEYS,
      "messageEventID",
      "senderID",
      "senderTurn",
      "messageBodySHA256",
      "messageBodyUTF8Bytes",
      "messageBodyUTF16CodeUnits",
    ]),
  ],
  [
    "spatial_observation",
    new Set([
      ...COMMON_KEYS,
      "present",
      "schemaVersion",
      "visibilityModel",
      "minimapPresent",
      "minimapSchemaVersion",
      "baseSerializedUTF8Bytes",
      "minimapSerializedUTF8Bytes",
    ]),
  ],
  [
    OWNER_EVIDENCE_SATURATION_KIND,
    new Set(["kind", "saturatedKind", "maximum"]),
  ],
]);

function fail(message) {
  throw new Error(message);
}

function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      FORBIDDEN_KEYS.has(key.toLowerCase()) || containsForbiddenKey(child),
  );
}

function isBoundedString(value, maxLength = 200) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL.test(value)
  );
}

function isBoundedIDArray(value, maxLength) {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    value.every((entry) => isBoundedString(entry)) &&
    new Set(value).size === value.length
  );
}

function exactEventSchema(event, file) {
  const allowed = ALLOWED_KEYS.get(event.kind);
  for (const key of Object.keys(event)) {
    if (!allowed.has(key)) fail(`${file}: unknown owner evidence field ${key}`);
  }
  if (event.kind === OWNER_EVIDENCE_SATURATION_KIND) {
    const supportedMaximum =
      OWNER_EVIDENCE_MAX_EVENTS_BY_KIND[event.saturatedKind];
    if (
      !Number.isSafeInteger(supportedMaximum) ||
      !Number.isSafeInteger(event.maximum) ||
      event.maximum < 0 ||
      event.maximum > supportedMaximum
    ) {
      fail(`${file}: malformed owner evidence saturation marker`);
    }
    return;
  }
  if (
    !isBoundedString(event.requestID) ||
    !Number.isSafeInteger(event.slot) ||
    event.slot < 0 ||
    !isBoundedString(event.ownPlayerID) ||
    !isBoundedString(event.selectedLegalActionID) ||
    typeof event.selectedLegalActionOffered !== "boolean"
  ) {
    fail(`${file}: malformed common owner evidence fields`);
  }
  if (event.kind === "deal_selection") {
    if (
      !isBoundedIDArray(event.offeredDealActionIDs, 16) ||
      !isBoundedString(event.selectedDealActionID)
    ) {
      fail(`${file}: malformed deal evidence fields`);
    }
  } else if (event.kind === "message_selection") {
    if (
      !isBoundedIDArray(event.offeredMessageActionIDs, 8) ||
      !isBoundedString(event.selectedMessageActionID) ||
      !isBoundedString(event.selectedMessageRecipientID)
    ) {
      fail(`${file}: malformed message-selection evidence fields`);
    }
  } else if (event.kind === "message_observation") {
    if (
      (Object.hasOwn(event, "messageEventID") &&
        !MESSAGE_EVENT_ID.test(event.messageEventID)) ||
      !isBoundedString(event.senderID) ||
      !Number.isSafeInteger(event.senderTurn) ||
      event.senderTurn < 0
    ) {
      fail(`${file}: malformed message-observation evidence fields`);
    }
  } else {
    if (
      typeof event.present !== "boolean" ||
      (event.present === true && typeof event.minimapPresent !== "boolean") ||
      (event.present === true &&
        event.minimapPresent === true &&
        ![1, 2].includes(event.minimapSchemaVersion)) ||
      (event.present === true &&
        event.minimapPresent === false &&
        "minimapSchemaVersion" in event)
    ) {
      fail(`${file}: malformed spatial evidence fields`);
    }
  }
}

function exactMessageEventIDChecks(events, required) {
  const observations = events.filter(
    (event) => event.kind === "message_observation",
  );
  const seen = new Set();
  for (const observation of observations) {
    if (!Object.hasOwn(observation, "messageEventID")) {
      if (required) {
        fail(
          `${observation.sourceFile}: required message observation is missing its server-owned messageEventID`,
        );
      }
      continue;
    }
    if (seen.has(observation.messageEventID)) {
      fail(
        `${observation.sourceFile}: duplicate server-owned messageEventID ${observation.messageEventID}`,
      );
    }
    seen.add(observation.messageEventID);
  }
}

function exactMessageDigestFields(event) {
  return (
    SHA256.test(event.messageBodySHA256 ?? "") &&
    Number.isSafeInteger(event.messageBodyUTF8Bytes) &&
    event.messageBodyUTF8Bytes >= 1 &&
    event.messageBodyUTF8Bytes <= 3 * 280 &&
    Number.isSafeInteger(event.messageBodyUTF16CodeUnits) &&
    event.messageBodyUTF16CodeUnits >= 1 &&
    event.messageBodyUTF16CodeUnits <= 280 &&
    event.messageBodyUTF8Bytes >= event.messageBodyUTF16CodeUnits &&
    event.messageBodyUTF8Bytes <= 3 * event.messageBodyUTF16CodeUnits
  );
}

function parseArgs(argv) {
  const spatialArg = argv.find((arg) => arg.startsWith("--spatial="));
  const spatial = spatialArg?.slice("--spatial=".length);
  if (
    !new Set([
      "absent",
      "present",
      "rich-v3",
      "rich-v3-minimap",
      "rich-v5",
      "rich-v5-minimap",
      "either",
    ]).has(spatial)
  ) {
    fail(USAGE);
  }
  const dealsArg = argv.find((arg) => arg.startsWith("--deals="));
  const deals = dealsArg?.slice("--deals=".length);
  const messagesArg = argv.find((arg) => arg.startsWith("--messages="));
  const messages = messagesArg?.slice("--messages=".length);
  if (
    !new Set(["required", "optional"]).has(deals) ||
    !new Set(["required", "optional"]).has(messages)
  ) {
    fail(USAGE);
  }
  const replayArgs = argv.filter((arg) => arg.startsWith("--replay="));
  if (replayArgs.length > 1) fail("at most one replay may be supplied");
  const replayArg = replayArgs[0];
  const requestedReplay = replayArg?.slice("--replay=".length);
  if (replayArg && !requestedReplay) fail(USAGE);
  if (requestedReplay && messages !== "required") {
    fail("--replay requires --messages=required");
  }
  const knownOptions = new Set([spatialArg, dealsArg, messagesArg, replayArg]);
  const unknownOption = argv.find(
    (arg) => arg.startsWith("--") && !knownOptions.has(arg),
  );
  if (unknownOption) fail(`unknown option ${unknownOption}`);
  const requestedFiles = argv.filter((arg) => !arg.startsWith("--"));
  if (requestedFiles.length === 0)
    fail("at least one downloaded policy log is required");
  if (requestedFiles.length > MAX_FILES)
    fail(`at most ${MAX_FILES} policy logs are allowed`);
  const canonicalFiles = requestedFiles.map((file) => {
    const canonicalPath = fs.realpathSync(file);
    const fileStat = fs.statSync(canonicalPath);
    return {
      canonicalPath,
      identity: `${fileStat.dev}:${fileStat.ino}`,
    };
  });
  if (
    new Set(canonicalFiles.map((file) => file.identity)).size !==
    canonicalFiles.length
  )
    fail("each downloaded policy log must resolve to a unique file");
  const files = canonicalFiles.map((file) => file.canonicalPath);
  const fileIdentities = new Map(
    canonicalFiles.map((file) => [file.canonicalPath, file.identity]),
  );
  let replay;
  let replayIdentity;
  if (requestedReplay) {
    const canonicalPath = fs.realpathSync(requestedReplay);
    const fileStat = fs.statSync(canonicalPath);
    const identity = `${fileStat.dev}:${fileStat.ino}`;
    if (canonicalFiles.some((file) => file.identity === identity)) {
      fail("the replay must be distinct from every policy log");
    }
    replay = canonicalPath;
    replayIdentity = identity;
  }
  return {
    deals,
    fileIdentities,
    files,
    messages,
    replay,
    replayIdentity,
    spatial,
  };
}

function readEvents(files, fileIdentities) {
  const events = [];
  for (const file of files) {
    const perKind = new Map();
    const bytes = readBoundedFile(
      file,
      MAX_FILE_BYTES,
      "policy log",
      fileIdentities.get(file),
    );
    let content;
    try {
      content = STRICT_UTF8.decode(bytes);
    } catch {
      fail(`${file}: policy log is not strict UTF-8`);
    }
    for (const line of content.split(/\r?\n/u)) {
      const offset = line.indexOf(PREFIX);
      if (offset < 0) continue;
      const encoded = line.slice(offset + PREFIX.length);
      if (Buffer.byteLength(encoded, "utf8") > MAX_LINE_BYTES) {
        fail(`${file}: oversized owner evidence line`);
      }
      let event;
      try {
        event = JSON.parse(encoded);
      } catch {
        fail(`${file}: malformed owner evidence JSON`);
      }
      if (!ALLOWED_KINDS.has(event?.kind)) {
        fail(`${file}: unknown owner evidence kind`);
      }
      if (containsForbiddenKey(event)) {
        fail(`${file}: forbidden raw/private evidence key`);
      }
      exactEventSchema(event, file);
      if (event.kind === OWNER_EVIDENCE_SATURATION_KIND) {
        fail(
          `${file}: owner evidence saturated ${event.saturatedKind} at ${event.maximum}; complete supported-horizon evidence is unavailable`,
        );
      }
      const count = (perKind.get(event.kind) ?? 0) + 1;
      const maximum = OWNER_EVIDENCE_MAX_EVENTS_BY_KIND[event.kind];
      if (count > maximum) {
        fail(`${file}: too many ${event.kind} events`);
      }
      perKind.set(event.kind, count);
      events.push({ ...event, sourceFile: file });
    }
  }
  return events;
}

function exactPolicyLogIdentityChecks(events, files) {
  const seenSlots = new Map();
  const seenPlayers = new Map();
  for (const file of files) {
    const fileEvents = events.filter((event) => event.sourceFile === file);
    if (fileEvents.length === 0) {
      fail(`${file}: policy log contained no owner evidence identity`);
    }
    const identities = new Map();
    for (const event of fileEvents) {
      const key = JSON.stringify([event.slot, event.ownPlayerID]);
      identities.set(key, { slot: event.slot, ownPlayerID: event.ownPlayerID });
    }
    if (identities.size !== 1) {
      fail(`${file}: policy log mixed multiple slot or player identities`);
    }
    const [{ slot, ownPlayerID }] = identities.values();
    const slotFile = seenSlots.get(slot);
    const playerFile = seenPlayers.get(ownPlayerID);
    if (
      (slotFile && slotFile !== file) ||
      (playerFile && playerFile !== file)
    ) {
      fail(
        "each supplied policy log must have a unique slot and player identity",
      );
    }
    seenSlots.set(slot, file);
    seenPlayers.set(ownPlayerID, file);
  }
  return files.map((file) => {
    const identity = events.find((event) => event.sourceFile === file);
    return {
      file,
      slot: identity.slot,
      ownPlayerID: identity.ownPlayerID,
    };
  });
}

function exactSelectionChecks(events) {
  for (const event of events) {
    if (
      (event.kind === "deal_selection" ||
        event.kind === "message_selection" ||
        event.kind === "message_observation" ||
        event.kind === "spatial_observation") &&
      event.selectedLegalActionOffered !== true
    ) {
      fail(`${event.sourceFile}: primary action was not recorded as offered`);
    }
    if (event.kind === "deal_selection") {
      if (
        !Array.isArray(event.offeredDealActionIDs) ||
        !event.offeredDealActionIDs.includes(event.selectedDealActionID)
      ) {
        fail(`${event.sourceFile}: selected deal ID was not exactly offered`);
      }
    }
    if (event.kind === "message_selection") {
      if (
        !Array.isArray(event.offeredMessageActionIDs) ||
        !event.offeredMessageActionIDs.includes(event.selectedMessageActionID)
      ) {
        fail(
          `${event.sourceFile}: selected message ID was not exactly offered`,
        );
      }
      if (!exactMessageDigestFields(event)) {
        fail(`${event.sourceFile}: invalid bounded outgoing message digest`);
      }
    }
    if (
      event.kind === "message_observation" &&
      !exactMessageDigestFields(event)
    ) {
      fail(`${event.sourceFile}: invalid inbound message digest`);
    }
  }
}

function joinedMessageChecks(events) {
  const selections = events.filter(
    (event) => event.kind === "message_selection",
  );
  const observations = events.filter(
    (event) => event.kind === "message_observation",
  );
  if (selections.length === 0 || observations.length === 0) {
    fail(
      "message selection and recipient-observation evidence are both required",
    );
  }
  const joinKey = ({
    messageBodySHA256,
    messageBodyUTF8Bytes,
    messageBodyUTF16CodeUnits,
    senderID,
    ownPlayerID,
  }) =>
    JSON.stringify([
      messageBodySHA256,
      messageBodyUTF8Bytes,
      messageBodyUTF16CodeUnits,
      senderID,
      ownPlayerID,
    ]);
  const observationsByJoin = new Map();
  for (const observation of observations) {
    const key = joinKey(observation);
    const queue = observationsByJoin.get(key) ?? { ids: [], next: 0 };
    queue.ids.push(observation.messageEventID);
    observationsByJoin.set(key, queue);
  }
  for (const selection of selections) {
    const queue = observationsByJoin.get(
      joinKey({
        ...selection,
        senderID: selection.ownPlayerID,
        ownPlayerID: selection.selectedMessageRecipientID,
      }),
    );
    if (!queue || queue.next >= queue.ids.length) {
      fail(
        `${selection.sourceFile}: no recipient observation joined the selected message digest`,
      );
    }
    queue.next += 1;
  }
}

function readBoundedFile(file, maximumBytes, label, expectedIdentity) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail(`${file}: ${label} is not a regular file`);
    if (
      expectedIdentity !== undefined &&
      `${stat.dev}:${stat.ino}` !== expectedIdentity
    ) {
      fail(`${file}: ${label} identity changed before verification`);
    }
    if (stat.size < 1 || stat.size > maximumBytes) {
      fail(`${file}: ${label} exceeds its bounded size`);
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read === 0) fail(`${file}: ${label} changed while being read`);
      offset += read;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, growthProbe, 0, 1, offset) !== 0) {
      fail(`${file}: ${label} changed while being read`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBoundedJsonFile(file, maximumBytes, label, expectedIdentity) {
  try {
    return JSON.parse(
      STRICT_UTF8.decode(
        readBoundedFile(file, maximumBytes, label, expectedIdentity),
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${file}:`)) {
      throw error;
    }
    fail(`${file}: malformed ${label} JSON`);
  }
}

function exactStringMap(rows, label, file) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 64) {
    fail(`${file}: malformed ${label} roster`);
  }
  const byUsername = new Map();
  const playerIDs = new Set();
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      !isBoundedString(row.username) ||
      !isBoundedString(row.playerID) ||
      byUsername.has(row.username) ||
      playerIDs.has(row.playerID)
    ) {
      fail(`${file}: malformed or duplicate ${label} identity`);
    }
    byUsername.set(row.username, row.playerID);
    playerIDs.add(row.playerID);
  }
  return { byUsername, playerIDs };
}

function replayMessageAuthority(file, expectedIdentity) {
  const replay = readBoundedJsonFile(
    file,
    MAX_REPLAY_BYTES,
    "replay",
    expectedIdentity,
  );
  if (!replay || typeof replay !== "object" || !isBoundedString(replay.runID)) {
    fail(`${file}: malformed replay identity`);
  }
  const gameEncoded = replay.inlineRunArtifacts?.["game-record.json"];
  const telemetryEncoded =
    replay.inlineRunArtifacts?.["spectator-telemetry.json"];
  if (
    typeof gameEncoded !== "string" ||
    typeof telemetryEncoded !== "string" ||
    Buffer.byteLength(gameEncoded, "utf8") > MAX_REPLAY_BYTES ||
    Buffer.byteLength(telemetryEncoded, "utf8") > MAX_REPLAY_BYTES
  ) {
    fail(`${file}: replay omitted bounded message authority artifacts`);
  }
  let game;
  let telemetry;
  try {
    game = JSON.parse(gameEncoded);
    telemetry = JSON.parse(telemetryEncoded);
  } catch {
    fail(`${file}: malformed replay message authority artifact`);
  }
  if (telemetry?.runID !== replay.runID) {
    fail(`${file}: replay telemetry identity does not match the run`);
  }
  const telemetryIDs = exactStringMap(
    telemetry?.agents,
    "spectator telemetry",
    file,
  );
  const finalIDs = exactStringMap(
    replay.finalState?.players,
    "final-state",
    file,
  );
  if (
    telemetryIDs.byUsername.size !== finalIDs.byUsername.size ||
    [...telemetryIDs.byUsername].some(
      ([username, playerID]) => finalIDs.byUsername.get(username) !== playerID,
    )
  ) {
    fail(`${file}: replay telemetry and final-state identities disagree`);
  }
  const playerIDBySlot = new Map(
    replay.finalState.players.map((player, slot) => [slot, player.playerID]),
  );
  const players = game?.info?.players;
  if (!Array.isArray(players) || players.length !== finalIDs.byUsername.size) {
    fail(`${file}: malformed game-record roster`);
  }
  const senderByClientID = new Map();
  const gameUsernames = new Set();
  const gamePlayerIDs = new Set();
  for (const player of players) {
    const playerID = finalIDs.byUsername.get(player?.username);
    if (
      !isBoundedString(player?.clientID) ||
      !playerID ||
      senderByClientID.has(player.clientID) ||
      gameUsernames.has(player.username) ||
      gamePlayerIDs.has(playerID)
    ) {
      fail(`${file}: game-record identity does not join the final roster`);
    }
    senderByClientID.set(player.clientID, playerID);
    gameUsernames.add(player.username);
    gamePlayerIDs.add(playerID);
  }
  if (
    gamePlayerIDs.size !== finalIDs.playerIDs.size ||
    [...finalIDs.playerIDs].some((playerID) => !gamePlayerIDs.has(playerID))
  ) {
    fail(`${file}: game-record roster does not cover every final player`);
  }
  const turnsPerDecisionStep = replay.config?.turns_per_decision_step;
  const maximumDecisionSteps = replay.config?.max_decision_steps;
  const finalTurn = replay.finalState?.turnCount;
  if (
    !Number.isSafeInteger(turnsPerDecisionStep) ||
    turnsPerDecisionStep < 1 ||
    !Number.isSafeInteger(maximumDecisionSteps) ||
    maximumDecisionSteps < 1 ||
    maximumDecisionSteps > 600 ||
    !Number.isSafeInteger(finalTurn) ||
    finalTurn < 1 ||
    game?.info?.num_turns !== finalTurn ||
    replay.results?.turn_count !== finalTurn
  ) {
    fail(`${file}: replay final-turn authority is inconsistent`);
  }
  const turns = game?.turns;
  if (
    !Array.isArray(turns) ||
    turns.length < 1 ||
    turns.length > maximumDecisionSteps + 1
  ) {
    fail(`${file}: malformed bounded game-record turns`);
  }
  const messages = [];
  const messagesByID = new Map();
  const messagesBySender = new Map();
  let priorTurn = -1;
  for (const turn of turns) {
    if (
      !Number.isSafeInteger(turn?.turnNumber) ||
      turn.turnNumber < 0 ||
      turn.turnNumber <= priorTurn ||
      !Array.isArray(turn.intents)
    ) {
      fail(`${file}: malformed or unordered game-record turn`);
    }
    priorTurn = turn.turnNumber;
    for (
      let intentIndex = 0;
      intentIndex < turn.intents.length;
      intentIndex += 1
    ) {
      const intent = turn.intents[intentIndex];
      if (intent?.type !== "agent_message") continue;
      const senderID = senderByClientID.get(intent.clientID);
      if (
        !senderID ||
        !telemetryIDs.playerIDs.has(intent.recipient) ||
        !isBoundedString(intent.text, 280) ||
        !MESSAGE_EVENT_ID.test(intent.messageEventID) ||
        messagesByID.has(intent.messageEventID)
      ) {
        fail(`${file}: malformed or duplicate authoritative replay message`);
      }
      const message = {
        messageEventID: intent.messageEventID,
        senderID,
        recipientID: intent.recipient,
        messageBodySHA256: createHash("sha256")
          .update(intent.text, "utf8")
          .digest("hex"),
        messageBodyUTF8Bytes: Buffer.byteLength(intent.text, "utf8"),
        messageBodyUTF16CodeUnits: intent.text.length,
        turnNumber: turn.turnNumber,
        intentIndex,
      };
      messages.push(message);
      messagesByID.set(message.messageEventID, message);
      const senderMessages = messagesBySender.get(senderID) ?? [];
      senderMessages.push(message);
      messagesBySender.set(senderID, senderMessages);
      if (messages.length > MAX_REPLAY_MESSAGES) {
        fail(`${file}: too many authoritative replay messages`);
      }
    }
  }
  const maximumRecordedTurn = turns.at(-1).turnNumber;
  if (finalTurn !== maximumRecordedTurn + turnsPerDecisionStep) {
    fail(`${file}: replay does not prove a terminal decision frame`);
  }
  return {
    file,
    maximumRecordedTurn,
    messages,
    messagesByID,
    messagesBySender,
    playerIDBySlot,
  };
}

function replayBoundMessageChecks(events, authority, policyIdentities) {
  const selections = events.filter(
    (event) => event.kind === "message_selection",
  );
  if (selections.length === 0) fail("message selection evidence is required");
  const observations = events.filter(
    (event) => event.kind === "message_observation",
  );
  const observationByID = new Map();
  for (const observation of observations) {
    const issued = authority.messagesByID.get(observation.messageEventID);
    if (
      !issued ||
      issued.senderID !== observation.senderID ||
      issued.recipientID !== observation.ownPlayerID ||
      issued.turnNumber !== observation.senderTurn ||
      issued.messageBodySHA256 !== observation.messageBodySHA256 ||
      issued.messageBodyUTF8Bytes !== observation.messageBodyUTF8Bytes ||
      issued.messageBodyUTF16CodeUnits !== observation.messageBodyUTF16CodeUnits
    ) {
      fail(
        `${observation.sourceFile}: recipient observation does not join its authoritative replay messageEventID`,
      );
    }
    observationByID.set(observation.messageEventID, observation);
  }
  const selectionsBySender = new Map();
  for (const selection of selections) {
    const senderSelections =
      selectionsBySender.get(selection.ownPlayerID) ?? [];
    senderSelections.push(selection);
    selectionsBySender.set(selection.ownPlayerID, senderSelections);
  }
  const terminalAdmissions = [];
  for (const { file, ownPlayerID: senderID, slot } of policyIdentities) {
    if (authority.playerIDBySlot.get(slot) !== senderID) {
      fail(`${file}: policy slot and player do not match the replay roster`);
    }
    const senderSelections = selectionsBySender.get(senderID) ?? [];
    const replayMessages = authority.messagesBySender.get(senderID) ?? [];
    if (replayMessages.length !== senderSelections.length) {
      fail(`${file}: replay message count does not match policy selections`);
    }
    let terminalAdmissionSeen = false;
    for (let index = 0; index < senderSelections.length; index += 1) {
      const selection = senderSelections[index];
      const issued = replayMessages[index];
      if (
        issued.recipientID !== selection.selectedMessageRecipientID ||
        issued.messageBodySHA256 !== selection.messageBodySHA256 ||
        issued.messageBodyUTF8Bytes !== selection.messageBodyUTF8Bytes ||
        issued.messageBodyUTF16CodeUnits !== selection.messageBodyUTF16CodeUnits
      ) {
        fail(
          `${selection.sourceFile}: chronological message selection does not match authoritative replay admission`,
        );
      }
      if (observationByID.has(issued.messageEventID)) continue;
      if (
        terminalAdmissionSeen ||
        index !== senderSelections.length - 1 ||
        issued.turnNumber !== authority.maximumRecordedTurn
      ) {
        fail(
          `${selection.sourceFile}: nonterminal selected message has no exact recipient observation`,
        );
      }
      terminalAdmissionSeen = true;
      terminalAdmissions.push(issued.messageEventID);
    }
  }
  return terminalAdmissions;
}

function spatialChecks(events, required, files) {
  const spatial = events.filter(
    (event) => event.kind === "spatial_observation",
  );
  const richV3 = ["rich-v3", "rich-v3-minimap"].includes(required);
  const richV5 = ["rich-v5", "rich-v5-minimap"].includes(required);
  const rich = richV3 || richV5;
  if (spatial.length === 0) fail("spatial observation evidence is required");
  if (
    (required === "present" || rich) &&
    !spatial.some((event) => event.present === true)
  )
    fail("no policy recorded a valid spatial observation");
  if (rich && !spatial.every((event) => event.present === true)) {
    fail("rich spatial evidence included an absent policy observation");
  }
  for (const file of files) {
    if (!spatial.some((event) => event.sourceFile === file)) {
      fail(`${file}: spatial evidence record is missing`);
    }
  }
  if (
    required === "absent" &&
    !spatial.every((event) => event.present === false)
  )
    fail("canonical social XP unexpectedly contained spatial state");
  if (richV3 && !spatial.every((event) => event.schemaVersion === 3)) {
    fail("rich spatial evidence included a non-v3 observation");
  }
  if (richV5 && !spatial.every((event) => event.schemaVersion === 5)) {
    fail("rich spatial evidence included a non-v5 observation");
  }
  if (
    required === "rich-v3" &&
    !spatial.every((event) => event.minimapPresent === false)
  ) {
    fail(
      "a rich v3 base-only policy observation unexpectedly included a minimap",
    );
  }
  if (
    required === "rich-v5" &&
    !spatial.every((event) => event.minimapPresent === false)
  ) {
    fail(
      "a rich v5 base-only policy observation unexpectedly included a minimap",
    );
  }
  if (
    required === "rich-v3-minimap" &&
    !spatial.every(
      (event) =>
        event.minimapPresent === true && event.minimapSchemaVersion === 1,
    )
  ) {
    fail("a rich v3 policy observation omitted the bounded v1 minimap");
  }
  if (
    required === "rich-v5-minimap" &&
    !spatial.every(
      (event) =>
        event.minimapPresent === true && event.minimapSchemaVersion === 2,
    )
  ) {
    fail("a rich v5 policy observation omitted the bounded v2 minimap");
  }
  for (const event of spatial.filter(
    (candidate) => candidate.present === true,
  )) {
    if (
      ![1, 3, 5].includes(event.schemaVersion) ||
      event.visibilityModel !== "global-lockstep-public-map-v1" ||
      typeof event.minimapPresent !== "boolean" ||
      (event.minimapPresent === true &&
        ![1, 2].includes(event.minimapSchemaVersion)) ||
      (event.minimapPresent === true &&
        [1, 3].includes(event.schemaVersion) &&
        event.minimapSchemaVersion !== 1) ||
      (event.minimapPresent === true &&
        event.schemaVersion === 5 &&
        event.minimapSchemaVersion !== 2) ||
      (event.minimapPresent === false && "minimapSchemaVersion" in event) ||
      !Number.isSafeInteger(event.baseSerializedUTF8Bytes) ||
      event.baseSerializedUTF8Bytes < 1 ||
      event.baseSerializedUTF8Bytes > 16 * 1024 ||
      (event.minimapPresent === true &&
        (!Number.isSafeInteger(event.minimapSerializedUTF8Bytes) ||
          event.minimapSerializedUTF8Bytes < 1 ||
          event.minimapSerializedUTF8Bytes > 4 * 1024)) ||
      (event.minimapPresent === false && "minimapSerializedUTF8Bytes" in event)
    ) {
      fail(`${event.sourceFile}: invalid spatial provenance or byte bound`);
    }
  }
  for (const event of spatial.filter(
    (candidate) => candidate.present === false,
  )) {
    if (
      "schemaVersion" in event ||
      "visibilityModel" in event ||
      "minimapPresent" in event ||
      "minimapSchemaVersion" in event ||
      "baseSerializedUTF8Bytes" in event ||
      "minimapSerializedUTF8Bytes" in event
    ) {
      fail(
        `${event.sourceFile}: absent spatial evidence carried present-only fields`,
      );
    }
  }
}

function main() {
  const {
    deals,
    fileIdentities,
    files,
    messages,
    replay,
    replayIdentity,
    spatial,
  } = parseArgs(process.argv.slice(2));
  const events = readEvents(files, fileIdentities);
  if (
    deals === "required" &&
    !events.some((event) => event.kind === "deal_selection")
  ) {
    fail("at least one exact deal selection is required");
  }
  const policyIdentities = exactPolicyLogIdentityChecks(events, files);
  exactSelectionChecks(events);
  exactMessageEventIDChecks(events, messages === "required");
  let terminalUnobservedMessageEventIDs = [];
  if (messages === "required") {
    if (replay) {
      terminalUnobservedMessageEventIDs = replayBoundMessageChecks(
        events,
        replayMessageAuthority(replay, replayIdentity),
        policyIdentities,
      );
    } else {
      joinedMessageChecks(events);
    }
  }
  spatialChecks(events, spatial, files);
  process.stdout.write(
    `${JSON.stringify({
      verdict: "PASS",
      files: files.length,
      events: events.length,
      deals: events.filter((event) => event.kind === "deal_selection").length,
      messageSelections: events.filter(
        (event) => event.kind === "message_selection",
      ).length,
      messageObservations: events.filter(
        (event) => event.kind === "message_observation",
      ).length,
      replayBound: Boolean(replay),
      terminalUnobservedMessageSelections:
        terminalUnobservedMessageEventIDs.length,
      terminalUnobservedMessageEventIDs,
      dealsMode: deals,
      messagesMode: messages,
      spatial,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
