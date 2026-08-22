import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  OWNER_MESSAGE_MAX_CHARS,
  OWNER_SPATIAL_SERIALIZED_MAX_BYTES,
  SPATIAL_VISIBILITY_MODEL,
  advertisedMessageLimit,
  boundedSpatialObservation,
  boundedSpatialV1,
  boundedSpatialV3,
  createOwnerCapabilityEvidenceLogger,
  dealResponseFields,
  isWithinOwnerSpatialSerializationCeiling,
  messageResponseFields,
  ownerCapabilityObservation,
  rankOfferedActionsWithSpatial,
} from "./owner-capabilities.mjs";

const deal = {
  id: "deal_accept:deal:P_A:P_B:non_aggression_pact:4",
  kind: "deal_accept",
};
const message = {
  id: "message:P_B",
  kind: "message",
  metadata: { recipientID: "P_B" },
};
const primary = { id: "hold", kind: "hold" };

test("deal slot requires observation capability and an exact offered deal id", () => {
  const args = {
    actions: [primary, deal],
    observation: {
      deals: {
        decisionStep: 4,
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [],
        rivalReliability: [],
      },
    },
  };
  assert.deepEqual(dealResponseFields({ ...args, dealMove: deal }), {
    selectedDealActionId: deal.id,
  });
  for (const id of [
    ` ${deal.id}`,
    `${deal.id} `,
    `${deal.id}:suffix`,
    deal.id.slice(0, -1),
  ]) {
    assert.deepEqual(dealResponseFields({ ...args, dealMove: { id } }), {});
  }
  assert.deepEqual(
    dealResponseFields({
      ...args,
      observation: {},
      dealMove: deal,
    }),
    {},
  );
  assert.deepEqual(
    dealResponseFields({
      ...args,
      observation: { deals: [] },
      dealMove: deal,
    }),
    {},
  );
  assert.deepEqual(dealResponseFields({ ...args, dealMove: { id: 7 } }), {});
  assert.deepEqual(
    dealResponseFields({
      ...args,
      dealMove: { id: primary.id },
    }),
    {},
  );
  for (const malformed of [
    [],
    {},
    { ...args.observation.deals, decisionStep: -1 },
    { ...args.observation.deals, activeDeals: {} },
  ]) {
    assert.deepEqual(
      dealResponseFields({
        ...args,
        observation: { deals: malformed },
        dealMove: deal,
      }),
      {},
    );
  }
});

test("message slot preserves valid raw text and rejects every unsafe boundary", () => {
  const protocol = { maxMessageChars: OWNER_MESSAGE_MAX_CHARS };
  const exact = ` pact  ${"x".repeat(273)}`;
  assert.equal(exact.length, 280);
  const fields = messageResponseFields({
    actions: [primary, message],
    protocol,
    messageMove: { id: message.id, text: exact },
  });
  assert.deepEqual(fields, {
    selectedMessageActionId: message.id,
    messageText: exact,
  });
  assert.equal(fields.messageText, exact);
  assert.equal(advertisedMessageLimit(protocol), 280);

  const rejected = [
    "x".repeat(281),
    "hello\u0000",
    "hello\u007f",
    "hello\u0085",
    "hello\u2028",
    "hello\u202e",
    "hello\u200b",
    "hello\u034f",
    "hello\u180e",
    "hello\ufe0f",
    "hello\ufeff",
    "hello\ud800",
    "hello\udc00",
    "   ",
  ];
  for (const text of rejected) {
    assert.deepEqual(
      messageResponseFields({
        actions: [primary, message],
        protocol,
        messageMove: { id: message.id, text },
      }),
      {},
    );
  }
  for (const id of [
    ` ${message.id}`,
    `${message.id} `,
    `${message.id}:suffix`,
    message.id.slice(0, -1),
    7,
  ]) {
    assert.deepEqual(
      messageResponseFields({
        actions: [primary, message],
        protocol,
        messageMove: { id, text: "hello" },
      }),
      {},
    );
  }
  assert.deepEqual(
    messageResponseFields({
      actions: [primary, message],
      protocol: {},
      messageMove: { id: message.id, text: "hello" },
    }),
    {},
  );
  assert.deepEqual(
    messageResponseFields({
      actions: [primary, message],
      protocol,
      messageMove: { id: message.id },
    }),
    {},
  );
});

function spatialObservation(minimap = undefined) {
  return {
    spatial: {
      schemaVersion: 1,
      visibilityModel: SPATIAL_VISIBILITY_MODEL,
      ownShape: {
        quadrant: "west",
        regionAnalysis: "complete",
        centroidBasis: "largest_region_border",
        coastShare: 25,
        centroid: { xPct: 30, yPct: 50 },
      },
      ...(minimap ? { minimap } : {}),
    },
    visiblePlayers: [
      {
        playerID: "P_A",
        distanceClass: "far",
        borderWithYou: {
          tiles: 5,
          shareOfYourBorder: 5,
          terrain: "land",
          defensePostsCovering: 0,
          underAttackHere: false,
        },
      },
      {
        playerID: "P_B",
        distanceClass: "adjacent",
        borderWithYou: {
          tiles: 70,
          shareOfYourBorder: 70,
          terrain: "mixed",
          defensePostsCovering: 2,
          underAttackHere: true,
        },
      },
    ],
  };
}

function richSpatialObservation() {
  return {
    ownState: { playerID: "P_SELF" },
    mapInfo: {
      name: "Pangaea",
      width: 100,
      height: 80,
      tileRefEncoding: "row-major-y-width-plus-x",
      coordinateFrame: {
        origin: "top_left",
        xIncreases: "east",
        yIncreases: "south",
      },
    },
    spatial: {
      schemaVersion: 3,
      visibilityModel: SPATIAL_VISIBILITY_MODEL,
      ownShape: {
        quadrant: "west",
        regionAnalysis: "complete",
        centroidBasis: "largest_region_border",
        coastShare: 25,
        centroid: { xPct: 30, yPct: 50 },
      },
      positionedAssets: {
        analysis: "complete",
        structures: [
          {
            ownerPlayerID: "P_SELF",
            type: "Defense Post",
            tile: 3025,
            x: 25,
            y: 30,
          },
        ],
        structuresTotal: 1,
        structuresReturned: 1,
        structuresTruncated: false,
        warships: [
          {
            ownerPlayerID: "P_A",
            type: "Warship",
            tile: 3060,
            x: 60,
            y: 30,
          },
        ],
        warshipsTotal: 1,
        warshipsReturned: 1,
        warshipsTruncated: false,
      },
    },
    visiblePlayers: [
      {
        playerID: "P_A",
        bearing: "east",
        distanceClass: "adjacent",
        borderWithYou: {
          tiles: 10,
          shareOfYourBorder: 25,
          terrain: "mixed",
          terrainBreakdown: {
            plains: 4,
            highland: 3,
            mountain: 3,
            shore: 2,
          },
          defensePostsCovering: 1,
          defensePostFrontCoverage: { covered: 6, uncovered: 4 },
          underAttackHere: false,
        },
        bordersWith: [],
      },
    ],
  };
}

test("spatial v1 can only reorder offered action objects", () => {
  const first = {
    id: "attack:P_A",
    kind: "attack",
    metadata: { targetID: "P_A" },
  };
  const second = {
    id: "attack:P_B",
    kind: "attack",
    metadata: { targetID: "P_B" },
  };
  const offered = [first, second];
  assert.deepEqual(rankOfferedActionsWithSpatial(offered, {}), offered);
  const ranked = rankOfferedActionsWithSpatial(offered, spatialObservation());
  assert.equal(ranked[0], second);
  assert.equal(ranked[1], first);
  assert.deepEqual(
    new Set(ranked.map((action) => action.id)),
    new Set(offered.map((action) => action.id)),
  );
  assert.equal("intent" in ranked[0], false);
});

test("absent optional capabilities preserve the legacy response bytes", () => {
  const legacy = {
    type: "decision_response",
    requestID: "req_legacy",
    selectedLegalActionId: primary.id,
    reason: "hold",
  };
  const upgraded = {
    ...legacy,
    ...dealResponseFields({
      actions: [primary],
      observation: {},
      dealMove: deal,
    }),
    ...messageResponseFields({
      actions: [primary],
      protocol: {},
      messageMove: message,
    }),
  };
  assert.equal(JSON.stringify(upgraded), JSON.stringify(legacy));
  assert.deepEqual(rankOfferedActionsWithSpatial([primary], {}), [primary]);
});

test("malformed optional containers disappear without crashing primary state", () => {
  const malformed = ownerCapabilityObservation({
    ownState: { playerID: "P_A" },
    visiblePlayers: {},
    deals: {
      decisionStep: 1,
      incomingProposals: {},
      outgoingProposals: [],
      activeDeals: [],
      proposalOptions: [],
      rivalReliability: [],
    },
    nonCombat: { inboundMessages: { senderID: "P_B" } },
  });
  assert.deepEqual(malformed.ownState, { playerID: "P_A" });
  assert.deepEqual(malformed.visiblePlayers, []);
  assert.equal("deals" in malformed, false);
  assert.equal("inboundMessages" in (malformed.nonCombat ?? {}), false);

  const valid = ownerCapabilityObservation({
    visiblePlayers: [],
    deals: {
      decisionStep: 1,
      incomingProposals: [],
      outgoingProposals: [],
      activeDeals: [],
      proposalOptions: [],
      rivalReliability: [],
    },
    nonCombat: {
      inboundMessages: [
        {
          senderID: "P_B",
          senderName: "Rival B",
          turnNumber: 7,
          text: "hold the border",
        },
      ],
    },
  });
  assert.ok(valid.deals);
  assert.equal(valid.nonCombat.inboundMessages.length, 1);
});

test("minimap is accepted whole or omitted whole without repair", () => {
  const valid = {
    schemaVersion: 1,
    width: 24,
    height: 12,
    rows: Array.from({ length: 12 }, () => "A".repeat(24)),
    legend: [
      {
        glyph: "A",
        playerID: "P_A",
        name: "legacy redundant name is not retained",
        isYou: false,
      },
    ],
  };
  assert.deepEqual(boundedSpatialV1(spatialObservation(valid)).minimap, {
    ...valid,
    legend: [{ glyph: "A", playerID: "P_A", isYou: false }],
  });
  for (const minimap of [
    { ...valid, width: 23 },
    { ...valid, rows: valid.rows.slice(1) },
    { ...valid, rows: ["!".repeat(24), ...valid.rows.slice(1)] },
    {
      ...valid,
      legend: [{ glyph: "AA", playerID: "P_A", name: "Auri", isYou: false }],
    },
    {
      ...valid,
      legend: [
        { glyph: "A", playerID: "P_A", isYou: false },
        { glyph: "B", playerID: "P_A", isYou: false },
      ],
    },
    {
      ...valid,
      rows: ["Z".repeat(24), ...valid.rows.slice(1)],
      legend: [],
    },
  ]) {
    const bounded = boundedSpatialV1(spatialObservation(minimap));
    assert.ok(bounded);
    assert.equal("minimap" in bounded, false);
  }
  assert.equal(
    boundedSpatialV1({
      ...spatialObservation(valid),
      spatial: {
        ...spatialObservation(valid).spatial,
        visibilityModel: "private-fog-bypass",
      },
    }),
    null,
  );

  for (const observation of [
    { ...spatialObservation(valid), visiblePlayers: {} },
    {
      ...spatialObservation(valid),
      visiblePlayers: [{ playerID: "P_A", bearing: "inside-secret-fog" }],
    },
    {
      ...spatialObservation(valid),
      visiblePlayers: [{ playerID: "P_A", distanceClass: "teleport" }],
    },
    {
      ...spatialObservation(valid),
      spatial: {
        ...spatialObservation(valid).spatial,
        ownShape: {
          ...spatialObservation(valid).spatial.ownShape,
          coastShare: 101,
        },
      },
    },
  ]) {
    assert.equal(boundedSpatialV1(observation), null);
  }
});

test("spatial serialization has an exact UTF-8 byte ceiling", () => {
  const wrapperBytes = Buffer.byteLength('{"payload":""}', "utf8");
  assert.equal(
    isWithinOwnerSpatialSerializationCeiling({
      payload: "x".repeat(OWNER_SPATIAL_SERIALIZED_MAX_BYTES - wrapperBytes),
    }),
    true,
  );
  assert.equal(
    isWithinOwnerSpatialSerializationCeiling({
      payload: "x".repeat(
        OWNER_SPATIAL_SERIALIZED_MAX_BYTES - wrapperBytes + 1,
      ),
    }),
    false,
  );

  const oversized = spatialObservation();
  oversized.visiblePlayers = Array.from({ length: 64 }, (_, playerIndex) => ({
    playerID: `P_${playerIndex}_${"x".repeat(190)}`,
    bearing: "east",
    distanceClass: "near",
    bordersWith: Array.from({ length: 64 }, (_, edgeIndex) => ({
      playerID: `E_${edgeIndex}_${"y".repeat(190)}`,
      sizeClass: "minor",
    })),
  }));
  assert.equal(boundedSpatialV1(oversized), null);
});

test("rich spatial L3 is exact, bounded, and fails closed atomically", () => {
  const valid = richSpatialObservation();
  const bounded = boundedSpatialV3(valid);
  assert.ok(bounded);
  assert.equal(bounded.schemaVersion, 3);
  assert.deepEqual(bounded.mapInfo, valid.mapInfo);
  assert.deepEqual(bounded.positionedAssets, valid.spatial.positionedAssets);
  assert.deepEqual(boundedSpatialObservation(valid), bounded);
  assert.equal(
    boundedSpatialObservation(spatialObservation()).schemaVersion,
    1,
  );

  const mutations = [
    (value) => {
      value.mapInfo.coordinateFrame.origin = "bottom_left";
    },
    (value) => {
      value.spatial.positionedAssets.warships[0].tile = 3_061;
    },
    (value) => {
      value.spatial.positionedAssets.structures[0].type = "Missile Silo";
    },
    (value) => {
      value.spatial.positionedAssets.structuresReturned = 0;
    },
    (value) => {
      value.spatial.positionedAssets.analysis = "capped";
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.terrainBreakdown.plains = 5;
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.defensePostFrontCoverage.covered = 7;
    },
    (value) => {
      value.visiblePlayers.push(structuredClone(value.visiblePlayers[0]));
    },
    (value) => {
      value.visiblePlayers[0].bordersWith = [
        { playerID: "P_HIDDEN", sizeClass: "minor" },
      ];
    },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    assert.equal(boundedSpatialV3(malformed), null);
  }

  const tooManyPerPlayer = structuredClone(valid);
  tooManyPerPlayer.spatial.positionedAssets.structures = Array.from(
    { length: 9 },
    (_, index) => ({
      ownerPlayerID: "P_SELF",
      type: "City",
      tile: index,
      x: index,
      y: 0,
    }),
  );
  tooManyPerPlayer.spatial.positionedAssets.structuresTotal = 9;
  tooManyPerPlayer.spatial.positionedAssets.structuresReturned = 9;
  assert.equal(boundedSpatialV3(tooManyPerPlayer), null);

  const malformedMinimap = structuredClone(valid);
  malformedMinimap.spatial.minimap = {
    schemaVersion: 1,
    width: 24,
    height: 12,
    rows: Array.from({ length: 12 }, () => "A".repeat(24)),
    legend: [{ glyph: "A", playerID: "P_A", isYou: false }],
  };
  malformedMinimap.spatial.minimap.rows[0] = `?${malformedMinimap.spatial.minimap.rows[0].slice(1)}`;
  assert.ok(boundedSpatialV3(malformedMinimap));
  assert.equal("minimap" in boundedSpatialV3(malformedMinimap), false);
});

test("rich spatial facts can only rerank exact offered legal action ids", () => {
  const observation = richSpatialObservation();
  observation.visiblePlayers.push({
    ...structuredClone(observation.visiblePlayers[0]),
    playerID: "P_B",
  });
  observation.spatial.positionedAssets.warships = [];
  observation.spatial.positionedAssets.warshipsTotal = 0;
  observation.spatial.positionedAssets.warshipsReturned = 0;
  const actions = [
    { id: "attack:P_A", kind: "attack", metadata: { targetID: "P_A" } },
    { id: "attack:P_B", kind: "attack", metadata: { targetID: "P_B" } },
  ];
  assert.equal(
    rankOfferedActionsWithSpatial(actions, observation)[0],
    actions[0],
  );

  observation.spatial.positionedAssets.warships = Array.from(
    { length: 8 },
    (_, index) => ({
      ownerPlayerID: "P_B",
      type: "Warship",
      tile: 4_000 + index,
      x: index,
      y: 40,
    }),
  );
  observation.spatial.positionedAssets.warshipsTotal = 8;
  observation.spatial.positionedAssets.warshipsReturned = 8;
  assert.equal(
    rankOfferedActionsWithSpatial(actions, observation)[0],
    actions[1],
  );
  assert.ok(
    rankOfferedActionsWithSpatial(actions, observation).every((action) =>
      actions.includes(action),
    ),
  );
});

test("capability evidence is bounded, joinable, and contains no raw body", () => {
  const lines = [];
  const logEvidence = createOwnerCapabilityEvidenceLogger({
    emit: (line) => lines.push(line),
    maxEventsPerKind: 1,
  });
  const body = "Hold the shared border exactly.";
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  const observation = {
    ...spatialObservation(),
    deals: {
      decisionStep: 4,
      incomingProposals: [],
      outgoingProposals: [],
      activeDeals: [],
      proposalOptions: [],
      rivalReliability: [],
    },
    nonCombat: {
      inboundMessages: [
        {
          senderID: "P_B",
          senderName: "Rival B",
          turnNumber: 7,
          text: body,
        },
      ],
    },
  };
  const args = {
    requestID: "req_evidence",
    slot: 0,
    actions: [primary, deal, message],
    observation,
    response: {
      selectedLegalActionId: primary.id,
      selectedDealActionId: deal.id,
      selectedMessageActionId: message.id,
      messageText: body,
    },
  };
  logEvidence(args);
  logEvidence(args);

  assert.equal(lines.length, 4);
  assert.equal(
    lines.some((line) => line.includes(body)),
    false,
  );
  const events = lines.map((line) =>
    JSON.parse(line.replace("PROXYWAR_OWNER_CAPABILITY_EVIDENCE ", "")),
  );
  assert.deepEqual(
    new Set(events.map((event) => event.kind)),
    new Set([
      "deal_selection",
      "message_selection",
      "message_observation",
      "spatial_observation",
    ]),
  );
  const selected = events.find((event) => event.kind === "message_selection");
  const observed = events.find((event) => event.kind === "message_observation");
  assert.equal(selected.messageBodySHA256, digest);
  assert.equal(observed.messageBodySHA256, digest);
  assert.deepEqual(selected.offeredMessageActionIDs, [message.id]);
  assert.equal(selected.selectedMessageActionID, message.id);
  assert.equal(selected.selectedLegalActionOffered, true);
});
