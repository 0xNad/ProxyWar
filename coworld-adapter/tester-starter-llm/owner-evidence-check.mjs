import fs from "node:fs";

const PREFIX = "PROXYWAR_OWNER_CAPABILITY_EVIDENCE ";
const MAX_LINE_BYTES = 8 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 25;
const MAX_EVENTS_PER_KIND_PER_FILE = 64;
const SHA256 = /^[0-9a-f]{64}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;
const ALLOWED_KINDS = new Set([
  "deal_selection",
  "message_selection",
  "message_observation",
  "spatial_observation",
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
      "serializedUTF8Bytes",
    ]),
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
      !isBoundedString(event.senderID) ||
      !Number.isSafeInteger(event.senderTurn) ||
      event.senderTurn < 0
    ) {
      fail(`${file}: malformed message-observation evidence fields`);
    }
  } else if (
    typeof event.present !== "boolean" ||
    (event.present === true && typeof event.minimapPresent !== "boolean")
  ) {
    fail(`${file}: malformed spatial evidence fields`);
  }
}

function exactMessageDigestFields(event) {
  return (
    SHA256.test(event.messageBodySHA256 ?? "") &&
    Number.isSafeInteger(event.messageBodyUTF8Bytes) &&
    event.messageBodyUTF8Bytes >= 1 &&
    event.messageBodyUTF8Bytes <= 4 * 280 &&
    Number.isSafeInteger(event.messageBodyUTF16CodeUnits) &&
    event.messageBodyUTF16CodeUnits >= 1 &&
    event.messageBodyUTF16CodeUnits <= 280
  );
}

function parseArgs(argv) {
  const spatialArg = argv.find((arg) => arg.startsWith("--spatial="));
  const spatial = spatialArg?.slice("--spatial=".length);
  if (
    !new Set(["absent", "present", "rich-v3", "rich-v3-minimap", "either"]).has(
      spatial,
    )
  ) {
    fail(
      "usage: node owner-evidence-check.mjs --deals=required|optional --messages=required|optional --spatial=absent|present|rich-v3|rich-v3-minimap|either LOG [LOG ...]",
    );
  }
  const dealsArg = argv.find((arg) => arg.startsWith("--deals="));
  const deals = dealsArg?.slice("--deals=".length);
  const messagesArg = argv.find((arg) => arg.startsWith("--messages="));
  const messages = messagesArg?.slice("--messages=".length);
  if (
    !new Set(["required", "optional"]).has(deals) ||
    !new Set(["required", "optional"]).has(messages)
  ) {
    fail(
      "usage: node owner-evidence-check.mjs --deals=required|optional --messages=required|optional --spatial=absent|present|rich-v3|rich-v3-minimap|either LOG [LOG ...]",
    );
  }
  const knownOptions = new Set([spatialArg, dealsArg, messagesArg]);
  const unknownOption = argv.find(
    (arg) => arg.startsWith("--") && !knownOptions.has(arg),
  );
  if (unknownOption) fail(`unknown option ${unknownOption}`);
  const files = argv.filter((arg) => !arg.startsWith("--"));
  if (files.length === 0)
    fail("at least one downloaded policy log is required");
  if (files.length > MAX_FILES)
    fail(`at most ${MAX_FILES} policy logs are allowed`);
  return { deals, files, messages, spatial };
}

function readEvents(files) {
  const events = [];
  for (const file of files) {
    if (fs.statSync(file).size > MAX_FILE_BYTES) {
      fail(`${file}: policy log exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const perKind = new Map();
    const content = fs.readFileSync(file, "utf8");
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
      const count = (perKind.get(event.kind) ?? 0) + 1;
      if (count > MAX_EVENTS_PER_KIND_PER_FILE) {
        fail(`${file}: too many ${event.kind} events`);
      }
      perKind.set(event.kind, count);
      events.push({ ...event, sourceFile: file });
    }
  }
  return events;
}

function exactSelectionChecks(events) {
  for (const event of events) {
    if (
      (event.kind === "deal_selection" ||
        event.kind === "message_selection" ||
        event.kind === "message_observation") &&
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
  const joinedObservationIndexes = new Set();
  for (const selection of selections) {
    const joinedIndex = observations.findIndex(
      (observation, index) =>
        !joinedObservationIndexes.has(index) &&
        observation.messageBodySHA256 === selection.messageBodySHA256 &&
        observation.messageBodyUTF8Bytes === selection.messageBodyUTF8Bytes &&
        observation.messageBodyUTF16CodeUnits ===
          selection.messageBodyUTF16CodeUnits &&
        observation.senderID === selection.ownPlayerID &&
        observation.ownPlayerID === selection.selectedMessageRecipientID,
    );
    if (joinedIndex < 0) {
      fail(
        `${selection.sourceFile}: no recipient observation joined the selected message digest`,
      );
    }
    joinedObservationIndexes.add(joinedIndex);
  }
}

function spatialChecks(events, required) {
  const spatial = events.filter(
    (event) => event.kind === "spatial_observation",
  );
  if (spatial.length === 0) fail("spatial observation evidence is required");
  if (
    ["present", "rich-v3", "rich-v3-minimap"].includes(required) &&
    !spatial.some((event) => event.present === true)
  )
    fail("no policy recorded a valid spatial observation");
  if (
    required === "absent" &&
    !spatial.every((event) => event.present === false)
  )
    fail("canonical social XP unexpectedly contained spatial state");
  if (
    ["rich-v3", "rich-v3-minimap"].includes(required) &&
    !spatial
      .filter((event) => event.present === true)
      .every((event) => event.schemaVersion === 3)
  ) {
    fail("rich spatial evidence included a non-v3 observation");
  }
  if (
    required === "rich-v3-minimap" &&
    !spatial
      .filter((event) => event.present === true)
      .every((event) => event.minimapPresent === true)
  ) {
    fail("a rich v3 policy observation omitted the bounded minimap");
  }
  for (const event of spatial.filter(
    (candidate) => candidate.present === true,
  )) {
    if (
      ![1, 3].includes(event.schemaVersion) ||
      event.visibilityModel !== "global-lockstep-public-map-v1" ||
      typeof event.minimapPresent !== "boolean" ||
      !Number.isSafeInteger(event.serializedUTF8Bytes) ||
      event.serializedUTF8Bytes < 1 ||
      event.serializedUTF8Bytes > 16 * 1024
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
      "serializedUTF8Bytes" in event
    ) {
      fail(
        `${event.sourceFile}: absent spatial evidence carried present-only fields`,
      );
    }
  }
}

function main() {
  const { deals, files, messages, spatial } = parseArgs(process.argv.slice(2));
  const events = readEvents(files);
  if (
    deals === "required" &&
    !events.some((event) => event.kind === "deal_selection")
  ) {
    fail("at least one exact deal selection is required");
  }
  exactSelectionChecks(events);
  if (messages === "required") joinedMessageChecks(events);
  spatialChecks(events, spatial);
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
