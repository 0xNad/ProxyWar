import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  OWNER_EVIDENCE_MAX_EVENTS_BY_KIND,
  OWNER_EVIDENCE_MAX_INBOUND_MESSAGES_PER_STEP,
  OWNER_EVIDENCE_SATURATION_KIND,
  OWNER_EVIDENCE_SUPPORTED_MAX_DECISION_STEPS,
  OWNER_MESSAGE_MAX_CHARS,
  OWNER_SPATIAL_SERIALIZED_MAX_BYTES,
  SPATIAL_VISIBILITY_MODEL,
  advertisedMessageLimit,
  boundedDealsObservation,
  boundedSpatialObservation,
  boundedSpatialV1,
  boundedSpatialV3,
  boundedSpatialV5,
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
const firstMessageEventID = "msg_00000000-0000-4000-8000-000000000001";
const secondMessageEventID = "msg_00000000-0000-4000-8000-000000000002";

test("deal slot requires observation capability and an exact offered deal id", () => {
  const args = {
    actions: [primary, deal],
    observation: {
      ownState: { playerID: "P_A" },
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
      observation: { ...args.observation, deals: [] },
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
        observation: { ...args.observation, deals: malformed },
        dealMove: deal,
      }),
      {},
    );
  }
});

test("deal capability rejects malformed nested state without emitting a slot", () => {
  const proposal = {
    dealID: "deal:P_A:P_B:support_request:4",
    proposerPlayerID: "P_A",
    proposerName: "Agent A",
    recipientPlayerID: "P_B",
    recipientName: "Agent B",
    terms: {
      template: "support_request",
      durationSteps: 6,
      goldAmount: "50000",
      troopAmount: 5000,
    },
    proposedAtStep: 4,
    answerableThroughStep: 8,
  };
  const active = {
    dealID: "deal:P_A:P_B:joint_attack:2",
    template: "joint_attack",
    proposerPlayerID: "P_A",
    proposerName: "Agent A",
    recipientPlayerID: "P_B",
    recipientName: "Agent B",
    activeFromStep: 3,
    expiresAfterStep: 14,
    stepsRemaining: 8,
    obligations: [
      {
        obligorPlayerID: "P_A",
        obligorName: "Agent A",
        kind: "confirmed_attack_on_target",
        status: "pending",
        targetPlayerID: "P_C",
        targetName: "Agent C",
      },
    ],
  };
  const nap = {
    dealID: "deal:P_A:P_B:non_aggression_pact:1",
    template: "non_aggression_pact",
    proposerPlayerID: "P_A",
    proposerName: "Agent A",
    recipientPlayerID: "P_B",
    recipientName: "Agent B",
    activeFromStep: 2,
    expiresAfterStep: 13,
    stepsRemaining: 7,
    obligations: [
      {
        obligorPlayerID: "P_A",
        obligorName: "Agent A",
        kind: "non_aggression",
        status: "pending",
      },
      {
        obligorPlayerID: "P_B",
        obligorName: "Agent B",
        kind: "non_aggression",
        status: "pending",
      },
    ],
  };
  const support = {
    dealID: "deal:P_A:P_B:support_request:0",
    template: "support_request",
    proposerPlayerID: "P_A",
    proposerName: "Agent A",
    recipientPlayerID: "P_B",
    recipientName: "Agent B",
    activeFromStep: 5,
    expiresAfterStep: 10,
    stepsRemaining: 4,
    obligations: [
      {
        obligorPlayerID: "P_B",
        obligorName: "Agent B",
        kind: "send_support",
        status: "pending",
        goldAmount: "50000",
        troopAmount: 5000,
        donatedGold: "0",
        donatedTroops: 0,
      },
    ],
  };
  const valid = {
    decisionStep: 7,
    incomingProposals: [proposal],
    outgoingProposals: [
      {
        ...proposal,
        dealID: "deal:P_B:P_D:trade_security_pact:5",
        proposerPlayerID: "P_B",
        proposerName: "Agent B",
        recipientPlayerID: "P_D",
        recipientName: "Agent D",
        terms: {
          template: "trade_security_pact",
          durationSteps: 12,
        },
        proposedAtStep: 5,
        answerableThroughStep: 9,
      },
    ],
    activeDeals: [active, nap, support],
    proposalOptions: [
      {
        recipientPlayerID: "P_C",
        recipientName: "Agent C",
        terms: {
          template: "non_aggression_pact",
          durationSteps: 12,
        },
      },
    ],
    rivalReliability: [
      {
        playerID: "P_C",
        name: "Agent C",
        fulfilled: 2,
        terminalNonMoot: 3,
        reliability: 0.67,
      },
    ],
  };
  assert.deepEqual(boundedDealsObservation(valid, "P_B"), valid);
  const violatedNap = {
    ...valid,
    activeDeals: [
      active,
      {
        ...nap,
        obligations: [
          { ...nap.obligations[0], status: "violated" },
          nap.obligations[1],
        ],
      },
      support,
    ],
  };
  assert.deepEqual(boundedDealsObservation(violatedNap, "P_B"), violatedNap);

  const selected = {
    id: `deal_accept:${proposal.dealID}`,
    kind: "deal_accept",
  };
  const malformed = [
    { ...valid, incomingProposals: [{ dealID: 7 }] },
    { ...valid, incomingProposals: [{}] },
    {
      ...valid,
      incomingProposals: [{ ...proposal, terms: [] }],
    },
    {
      ...valid,
      incomingProposals: [{ ...proposal, dealID: ` ${proposal.dealID}` }],
    },
    {
      ...valid,
      outgoingProposals: [{ ...proposal }],
    },
    {
      ...valid,
      incomingProposals: [
        { ...proposal, recipientPlayerID: "P_C", recipientName: "Agent C" },
      ],
    },
    {
      ...valid,
      incomingProposals: [{ ...proposal, answerableThroughStep: 7 }],
    },
    {
      ...valid,
      incomingProposals: [
        {
          ...proposal,
          terms: {
            template: "joint_attack",
            durationSteps: 8,
            targetPlayerID: "P_A",
            targetName: "Agent A",
          },
        },
      ],
    },
    {
      ...valid,
      decisionStep: 9,
    },
    {
      ...valid,
      activeDeals: [
        {
          ...active,
          obligations: [{ ...active.obligations[0], status: 7 }],
        },
      ],
    },
    {
      ...valid,
      activeDeals: [
        {
          ...nap,
          obligations: [nap.obligations[0], { ...nap.obligations[0] }],
        },
      ],
    },
    {
      ...valid,
      activeDeals: [
        {
          ...nap,
          obligations: [
            { ...nap.obligations[0], status: "moot" },
            nap.obligations[1],
          ],
        },
      ],
    },
    {
      ...valid,
      activeDeals: [
        {
          ...nap,
          obligations: [
            { ...nap.obligations[0], status: "fulfilled" },
            nap.obligations[1],
          ],
        },
      ],
    },
    {
      ...valid,
      activeDeals: [
        {
          ...support,
          obligations: [
            {
              ...support.obligations[0],
              obligorPlayerID: "P_A",
              obligorName: "Agent A",
            },
          ],
        },
      ],
    },
    {
      ...valid,
      activeDeals: [{ ...active, activeFromStep: undefined }],
    },
    {
      ...valid,
      activeDeals: [{ ...active, stepsRemaining: 7 }],
    },
    {
      ...valid,
      activeDeals: [{ ...active, expiresAfterStep: 30, stepsRemaining: 24 }],
    },
    {
      ...valid,
      activeDeals: [
        {
          ...active,
          obligations: [
            {
              ...active.obligations[0],
              obligorPlayerID: "P_B",
              obligorName: "Agent B",
            },
          ],
        },
      ],
    },
    {
      ...valid,
      activeDeals: [
        {
          ...active,
          obligations: [{ ...active.obligations[0], status: "fulfilled" }],
        },
      ],
    },
    {
      ...valid,
      activeDeals: [
        {
          ...active,
          proposerPlayerID: "P_C",
          proposerName: "Agent C",
          recipientPlayerID: "P_D",
          recipientName: "Agent D",
          obligations: [
            {
              ...active.obligations[0],
              obligorPlayerID: "P_C",
              obligorName: "Agent C",
            },
          ],
        },
      ],
    },
    {
      ...valid,
      proposalOptions: [
        {
          recipientPlayerID: "P_B",
          recipientName: "Agent B",
          terms: {
            template: "non_aggression_pact",
            durationSteps: 12,
          },
        },
      ],
    },
    {
      ...valid,
      rivalReliability: [
        {
          playerID: "P_B",
          name: "Agent B",
          fulfilled: 0,
          terminalNonMoot: 0,
          reliability: null,
        },
      ],
    },
    { ...valid, privateDealNotes: "must not enter policy state" },
  ];
  for (const deals of malformed) {
    assert.equal(boundedDealsObservation(deals, "P_B"), null);
    assert.deepEqual(
      dealResponseFields({
        actions: [primary, selected],
        observation: { ownState: { playerID: "P_B" }, deals },
        dealMove: selected,
      }),
      {},
    );
    assert.equal(
      "deals" in
        ownerCapabilityObservation({
          ownState: { playerID: "P_B" },
          deals,
          visiblePlayers: [],
        }),
      false,
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
  assert.equal(advertisedMessageLimit({ maxMessageChars: 1e20 }), null);

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
    ownState: { playerID: "P_SELF" },
    spatial: {
      schemaVersion: 1,
      visibilityModel: SPATIAL_VISIBILITY_MODEL,
      ownShape: {
        quadrant: "west",
        compactness: "compact",
        regionCount: 1,
        largestRegionShare: 100,
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
        compactness: "compact",
        regionCount: 1,
        largestRegionShare: 100,
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
        sharesBorder: true,
        incomingAttack: false,
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

function richSpatialObservationV5() {
  const observation = richSpatialObservation();
  observation.spatial.schemaVersion = 5;
  observation.spatial.ownShape.largestNeighborBorderShare = 25;
  observation.visiblePlayers[0].bordersWith = [];
  observation.visiblePlayers[0].navalExposure = {
    transportReachableOwnShoreTiles: 12,
  };
  observation.spatial.minimap = {
    schemaVersion: 2,
    width: 24,
    height: 12,
    ownershipRows: Array.from({ length: 12 }, (_, row) =>
      row === 4 ? "......A.......~........." : ".".repeat(24),
    ),
    terrainRows: Array.from({ length: 12 }, (_, row) =>
      row === 4 ? "..............~........." : ".".repeat(24),
    ),
    legend: [
      { glyph: "A", playerID: "P_SELF", isYou: true },
      { glyph: "B", playerID: "P_A", isYou: false },
    ],
    markers: [
      { type: "D", ownerPlayerID: "P_SELF", x: 6, y: 4 },
      { type: "W", ownerPlayerID: "P_A", x: 14, y: 4 },
    ],
    markersTotal: 2,
    markersReturned: 2,
    markersTruncated: false,
  };
  return observation;
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
    ownState: { playerID: "P_A" },
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
          messageEventID: firstMessageEventID,
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
  assert.equal(
    valid.nonCombat.inboundMessages[0].messageEventID,
    firstMessageEventID,
  );

  const fourFromOneSender = ownerCapabilityObservation({
    ownState: { playerID: "P_A" },
    visiblePlayers: [],
    nonCombat: {
      inboundMessages: Array.from({ length: 4 }, (_, index) => ({
        senderID: "P_B",
        senderName: "Rival B",
        turnNumber: index + 1,
        text: `message ${index + 1}`,
      })),
    },
  });
  assert.equal("inboundMessages" in (fourFromOneSender.nonCombat ?? {}), false);

  const threePerSender = ownerCapabilityObservation({
    ownState: { playerID: "P_A" },
    visiblePlayers: [],
    nonCombat: {
      inboundMessages: Array.from({ length: 6 }, (_, index) => ({
        senderID: index % 2 === 0 ? "P_B" : "P_C",
        senderName: index % 2 === 0 ? "Rival B" : "Rival C",
        turnNumber: index + 1,
        text: `message ${index + 1}`,
        futurePrivateField: "must not reach the policy prompt",
      })),
    },
  });
  assert.equal(threePerSender.nonCombat.inboundMessages.length, 6);
  assert.equal(
    threePerSender.nonCombat.inboundMessages.some(
      (entry) => "futurePrivateField" in entry,
    ),
    false,
  );

  const outOfOrder = ownerCapabilityObservation({
    ownState: { playerID: "P_A" },
    visiblePlayers: [],
    nonCombat: {
      inboundMessages: [
        { senderID: "P_B", senderName: "B", turnNumber: 8, text: "later" },
        { senderID: "P_C", senderName: "C", turnNumber: 7, text: "earlier" },
      ],
    },
  });
  assert.equal("inboundMessages" in (outOfOrder.nonCombat ?? {}), false);
});

test("server message IDs preserve distinct same-turn messages and drive evidence dedupe", () => {
  const body = "same sender, turn, and body";
  const input = {
    ownState: { playerID: "P_A" },
    visiblePlayers: [],
    nonCombat: {
      inboundMessages: [firstMessageEventID, secondMessageEventID].map(
        (messageEventID) => ({
          messageEventID,
          senderID: "P_B",
          senderName: "Rival B",
          turnNumber: 7,
          text: body,
        }),
      ),
    },
  };
  const sanitized = ownerCapabilityObservation(input);
  assert.deepEqual(
    sanitized.nonCombat.inboundMessages.map((entry) => entry.messageEventID),
    [firstMessageEventID, secondMessageEventID],
  );

  const lines = [];
  const logEvidence = createOwnerCapabilityEvidenceLogger({
    emit: (line) => lines.push(line),
  });
  const args = {
    requestID: "req_same_turn_ids",
    slot: 0,
    actions: [primary],
    observation: input,
    response: { selectedLegalActionId: primary.id },
  };
  logEvidence(args);
  logEvidence(args);
  const observations = lines
    .map((line) =>
      JSON.parse(line.replace("PROXYWAR_OWNER_CAPABILITY_EVIDENCE ", "")),
    )
    .filter((event) => event.kind === "message_observation");
  assert.deepEqual(
    observations.map((event) => event.messageEventID),
    [firstMessageEventID, secondMessageEventID],
  );
});

test("malformed or duplicate server message IDs fail the inbound container closed", () => {
  const observationWithIDs = (messageEventIDs) => ({
    ownState: { playerID: "P_A" },
    visiblePlayers: [],
    nonCombat: {
      inboundMessages: messageEventIDs.map((messageEventID, index) => ({
        messageEventID,
        senderID: "P_B",
        senderName: "Rival B",
        turnNumber: 7 + index,
        text: `message ${index}`,
      })),
    },
  });
  for (const malformedID of [
    "msg_A",
    "MSG_00000000-0000-4000-8000-000000000001",
    "msg_00000000-0000-3000-8000-000000000001",
    "msg_00000000-0000-4000-7000-000000000001",
    ` ${firstMessageEventID}`,
    7,
  ]) {
    const sanitized = ownerCapabilityObservation(
      observationWithIDs([malformedID]),
    );
    assert.equal("inboundMessages" in (sanitized.nonCombat ?? {}), false);
  }
  const duplicate = ownerCapabilityObservation(
    observationWithIDs([firstMessageEventID, firstMessageEventID]),
  );
  assert.equal("inboundMessages" in (duplicate.nonCombat ?? {}), false);
});

test("minimap is accepted whole or omitted whole without repair", () => {
  const valid = {
    schemaVersion: 1,
    width: 24,
    height: 12,
    rows: Array.from({ length: 12 }, () => "A".repeat(24)),
    legend: [
      {
        glyph: "S",
        playerID: "P_SELF",
        isYou: true,
      },
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
    legend: [
      { glyph: "S", playerID: "P_SELF", isYou: true },
      { glyph: "A", playerID: "P_A", isYou: false },
    ],
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
        { glyph: "S", playerID: "P_SELF", isYou: true },
        { glyph: "A", playerID: "P_A", isYou: false },
        { glyph: "B", playerID: "P_A", isYou: false },
      ],
    },
    {
      ...valid,
      rows: ["Z".repeat(24), ...valid.rows.slice(1)],
      legend: [],
    },
    {
      ...valid,
      legend: [
        { glyph: "S", playerID: "P_HIDDEN", isYou: true },
        { glyph: "A", playerID: "P_A", isYou: false },
      ],
    },
    {
      ...valid,
      legend: [
        { glyph: "S", playerID: "P_SELF", isYou: false },
        { glyph: "A", playerID: "P_A", isYou: true },
      ],
    },
  ]) {
    const bounded = boundedSpatialV1(spatialObservation(minimap));
    assert.ok(bounded);
    assert.equal("minimap" in bounded, false);
  }

  const oversizedMinimapObservation = spatialObservation();
  oversizedMinimapObservation.visiblePlayers = Array.from(
    { length: 63 },
    (_, index) => ({
      playerID: `P_${String(index).padStart(2, "0")}_${"x".repeat(190)}`,
    }),
  );
  oversizedMinimapObservation.spatial.minimap = {
    ...valid,
    legend: Array.from({ length: 64 }, (_, index) => ({
      glyph: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#"[
        index
      ],
      playerID:
        index === 0
          ? "P_SELF"
          : `P_${String(index - 1).padStart(2, "0")}_${"x".repeat(190)}`,
      isYou: index === 0,
    })),
  };
  const oversizedMinimap = boundedSpatialV1(oversizedMinimapObservation);
  assert.ok(oversizedMinimap);
  assert.equal("minimap" in oversizedMinimap, false);
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

  const cappedWarshipsMissingPost = structuredClone(valid);
  cappedWarshipsMissingPost.spatial.positionedAssets.analysis = "capped";
  cappedWarshipsMissingPost.spatial.positionedAssets.structures = [];
  cappedWarshipsMissingPost.spatial.positionedAssets.structuresTotal = 0;
  cappedWarshipsMissingPost.spatial.positionedAssets.structuresReturned = 0;
  cappedWarshipsMissingPost.spatial.positionedAssets.warshipsTotal += 1;
  cappedWarshipsMissingPost.spatial.positionedAssets.warshipsTruncated = true;
  assert.equal(boundedSpatialV3(cappedWarshipsMissingPost), null);

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

  const colocated = structuredClone(valid);
  colocated.spatial.positionedAssets.warships.push(
    structuredClone(colocated.spatial.positionedAssets.warships[0]),
  );
  colocated.spatial.positionedAssets.warshipsTotal = 2;
  colocated.spatial.positionedAssets.warshipsReturned = 2;
  assert.equal(boundedSpatialV3(colocated).positionedAssets.warships.length, 2);

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

  const downgradedParentWithV2Minimap = structuredClone(valid);
  downgradedParentWithV2Minimap.spatial.minimap = structuredClone(
    richSpatialObservationV5().spatial.minimap,
  );
  assert.ok(boundedSpatialV3(downgradedParentWithV2Minimap));
  assert.equal(
    "minimap" in boundedSpatialV3(downgradedParentWithV2Minimap),
    false,
  );

  const partialL4 = structuredClone(valid);
  partialL4.spatial.ownShape.largestNeighborBorderShare = {
    futurePrivate: "SENTINEL",
  };
  partialL4.visiblePlayers.push({
    playerID: "P_B",
    distanceClass: "far",
    bordersWith: [
      { playerID: "P_A", sizeClass: "minor", tiles: { private: true } },
    ],
  });
  partialL4.visiblePlayers[0].bordersWith = [
    { playerID: "P_B", sizeClass: "minor", tiles: { private: true } },
  ];
  const boundedPartialL4 = boundedSpatialV3(partialL4);
  assert.ok(boundedPartialL4);
  assert.equal(
    "largestNeighborBorderShare" in boundedPartialL4.ownShape,
    false,
  );
  assert.equal("tiles" in boundedPartialL4.rivals[0].bordersWith[0], false);
});

test("rich spatial L5 admits weighted exposure and a complete terrain marker minimap", () => {
  const valid = richSpatialObservationV5();
  const bounded = boundedSpatialV5(valid);
  assert.ok(bounded);
  assert.equal(bounded.schemaVersion, 5);
  assert.equal(bounded.ownShape.largestNeighborBorderShare, 25);
  assert.deepEqual(bounded.rivals[0].navalExposure, {
    transportReachableOwnShoreTiles: 12,
  });
  assert.equal(bounded.minimap.schemaVersion, 2);
  assert.deepEqual(bounded.minimap.markers, [
    { type: "D", ownerPlayerID: "P_SELF", x: 6, y: 4 },
    { type: "W", ownerPlayerID: "P_A", x: 14, y: 4 },
  ]);
  assert.deepEqual(boundedSpatialObservation(valid), bounded);

  const validWeightedGraph = structuredClone(valid);
  validWeightedGraph.visiblePlayers.push({
    ...structuredClone(valid.visiblePlayers[0]),
    playerID: "P_B",
    bordersWith: [],
    navalExposure: { transportReachableOwnShoreTiles: 0 },
  });
  validWeightedGraph.visiblePlayers[0].bordersWith = [
    { playerID: "P_B", sizeClass: "minor", tiles: 3 },
  ];
  validWeightedGraph.visiblePlayers[1].bordersWith = [
    { playerID: "P_A", sizeClass: "minor", tiles: 4 },
  ];
  assert.ok(boundedSpatialV5(validWeightedGraph));

  const mutations = [
    (value) => {
      value.spatial.ownShape.largestNeighborBorderShare = 101;
    },
    (value) => {
      value.spatial.ownShape.largestNeighborBorderShare = 0;
    },
    (value) => {
      value.spatial.ownShape.largestNeighborBorderShare = 25.5;
      value.visiblePlayers[0].borderWithYou.shareOfYourBorder = 25.5;
    },
    (value) => {
      delete value.spatial.ownShape.compactness;
      delete value.spatial.ownShape.regionCount;
      delete value.spatial.ownShape.largestRegionShare;
    },
    (value) => {
      value.spatial.ownShape.regionAnalysis = "omitted_budget";
    },
    (value) => {
      value.spatial.ownShape.compactness = "fragmented";
    },
    (value) => {
      value.spatial.ownShape.regionCount = 2;
      value.spatial.ownShape.largestRegionShare = 80;
    },
    (value) => {
      value.spatial.ownShape.regionCount = Number.MAX_SAFE_INTEGER;
    },
    (value) => {
      value.visiblePlayers[0].navalExposure.transportReachableOwnShoreTiles =
        -1;
    },
    (value) => {
      value.visiblePlayers[0].navalExposure.transportReachableOwnShoreTiles =
        Number.MAX_SAFE_INTEGER;
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.tiles = Number.MAX_SAFE_INTEGER;
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.tiles = 0;
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.defensePostsCovering =
        Number.MAX_SAFE_INTEGER;
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.terrain = "land";
      value.visiblePlayers[0].borderWithYou.terrainBreakdown.shore = 1;
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.defensePostsCovering = 0;
      value.visiblePlayers[0].borderWithYou.defensePostFrontCoverage.covered = 1;
      value.visiblePlayers[0].borderWithYou.defensePostFrontCoverage.uncovered =
        value.visiblePlayers[0].borderWithYou.tiles - 1;
    },
    (value) => {
      delete value.visiblePlayers[0].distanceClass;
    },
    (value) => {
      delete value.visiblePlayers[0].bordersWith;
    },
    (value) => {
      value.visiblePlayers[0].sharesBorder = false;
    },
    (value) => {
      delete value.visiblePlayers[0].borderWithYou;
      value.spatial.ownShape.largestNeighborBorderShare = 0;
    },
    (value) => {
      value.visiblePlayers[0].distanceClass = "near";
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.underAttackHere = true;
    },
    (value) => {
      value.visiblePlayers[0].borderWithYou.defensePostsCovering = 2;
    },
    (value) => {
      value.visiblePlayers[0].navalExposure.nearestEnemyPort = {
        bearing: "east",
        distanceClass: "near",
      };
    },
    (value) => {
      value.visiblePlayers[0].bordersWith = [
        { playerID: "P_A", sizeClass: "minor", tiles: 0 },
      ];
    },
    (value) => {
      value.visiblePlayers[0].bordersWith = [
        {
          playerID: "P_A",
          sizeClass: "minor",
          tiles: Number.MAX_SAFE_INTEGER,
        },
      ];
    },
    (value) => {
      value.visiblePlayers[0].bordersWith = [
        { playerID: "P_SELF", sizeClass: "minor", tiles: 1 },
      ];
    },
    (value) => {
      value.visiblePlayers[0].bordersWith = [
        { playerID: "P_A", sizeClass: "minor", tiles: 1 },
      ];
    },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    assert.equal(boundedSpatialV5(malformed), null);
  }

  const cappedV5WarshipsMissingPost = structuredClone(valid);
  cappedV5WarshipsMissingPost.spatial.positionedAssets.analysis = "capped";
  cappedV5WarshipsMissingPost.spatial.positionedAssets.structures = [];
  cappedV5WarshipsMissingPost.spatial.positionedAssets.structuresTotal = 0;
  cappedV5WarshipsMissingPost.spatial.positionedAssets.structuresReturned = 0;
  cappedV5WarshipsMissingPost.spatial.positionedAssets.warshipsTotal += 1;
  cappedV5WarshipsMissingPost.spatial.positionedAssets.warshipsTruncated = true;
  assert.equal(boundedSpatialV5(cappedV5WarshipsMissingPost), null);

  const cappedWarshipsMissingPort = structuredClone(valid);
  cappedWarshipsMissingPort.spatial.positionedAssets.analysis = "capped";
  cappedWarshipsMissingPort.spatial.positionedAssets.warshipsTotal += 1;
  cappedWarshipsMissingPort.spatial.positionedAssets.warshipsTruncated = true;
  cappedWarshipsMissingPort.visiblePlayers[0].navalExposure.nearestEnemyPort = {
    bearing: "east",
    distanceClass: "near",
  };
  assert.equal(boundedSpatialV5(cappedWarshipsMissingPort), null);

  const duplicateEdge = structuredClone(validWeightedGraph);
  duplicateEdge.visiblePlayers[0].bordersWith.push({
    ...duplicateEdge.visiblePlayers[0].bordersWith[0],
  });
  assert.equal(boundedSpatialV5(duplicateEdge), null);
  const asymmetricEdge = structuredClone(validWeightedGraph);
  asymmetricEdge.visiblePlayers[1].bordersWith = [];
  assert.equal(boundedSpatialV5(asymmetricEdge), null);

  const legacyMinimap = structuredClone(valid);
  legacyMinimap.spatial.minimap = {
    schemaVersion: 1,
    width: 24,
    height: 12,
    rows: Array.from({ length: 12 }, () => "A".repeat(24)),
    legend: [{ glyph: "A", playerID: "P_SELF", isYou: true }],
  };
  assert.ok(boundedSpatialV5(legacyMinimap));
  assert.equal("minimap" in boundedSpatialV5(legacyMinimap), false);

  for (const mutateMinimap of [
    (value) => {
      value.spatial.minimap.terrainRows[0] = `X${value.spatial.minimap.terrainRows[0].slice(1)}`;
    },
    (value) => {
      value.spatial.minimap.markers[0].ownerPlayerID = "P_HIDDEN";
    },
    (value) => {
      value.spatial.minimap.markersReturned = 0;
    },
    (value) => {
      value.spatial.minimap.width = 32;
      value.spatial.minimap.height = 16;
      value.spatial.minimap.ownershipRows = Array.from({ length: 16 }, () =>
        ".".repeat(32),
      );
      value.spatial.minimap.terrainRows = Array.from({ length: 16 }, () =>
        ".".repeat(32),
      );
    },
    (value) => {
      value.spatial.minimap.markersTotal += 1;
      value.spatial.minimap.markersTruncated = true;
    },
    (value) => {
      value.spatial.minimap = null;
    },
    (value) => {
      value.spatial.minimap.legend[0] = null;
    },
    (value) => {
      value.spatial.minimap.markers[0] = null;
    },
    (value) => {
      value.spatial.minimap.markers[0].type = ["D"];
    },
  ]) {
    const malformed = structuredClone(valid);
    mutateMinimap(malformed);
    const stillRich = boundedSpatialV5(malformed);
    assert.ok(stillRich);
    assert.equal("minimap" in stillRich, false);
  }
});

test("rich spatial and minimap retain their independent wire byte ceilings", () => {
  const idLength = 65;
  const ownPlayerID = "S".repeat(idLength);
  const rivalIDs = Array.from(
    { length: 6 },
    (_, index) =>
      `${String.fromCharCode(65 + index).repeat(idLength - 2)}${String(index).padStart(2, "0")}`,
  );
  const positionedAssets = (type) =>
    rivalIDs.flatMap((ownerPlayerID, playerIndex) =>
      Array.from({ length: 8 }, (_, assetIndex) => ({
        ownerPlayerID,
        type,
        tile: playerIndex * 1000 + assetIndex,
        x: assetIndex,
        y: playerIndex,
      })),
    );
  const observation = {
    ownState: { playerID: ownPlayerID },
    mapInfo: {
      name: "Boundary",
      width: 1000,
      height: 300,
      tileRefEncoding: "row-major-y-width-plus-x",
      coordinateFrame: {
        origin: "top_left",
        xIncreases: "east",
        yIncreases: "south",
      },
    },
    spatial: {
      schemaVersion: 5,
      visibilityModel: SPATIAL_VISIBILITY_MODEL,
      ownShape: {
        quadrant: "center",
        compactness: "compact",
        regionCount: 1,
        largestRegionShare: 100,
        regionAnalysis: "complete",
        centroidBasis: "largest_region_border",
        coastShare: 0,
        largestNeighborBorderShare: 0,
        centroid: { xPct: 50, yPct: 50 },
      },
      positionedAssets: {
        analysis: "complete",
        structures: positionedAssets("City"),
        structuresTotal: 48,
        structuresReturned: 48,
        structuresTruncated: false,
        warships: positionedAssets("Warship"),
        warshipsTotal: 48,
        warshipsReturned: 48,
        warshipsTruncated: false,
      },
    },
    visiblePlayers: rivalIDs.map((playerID) => ({
      playerID,
      sharesBorder: false,
      distanceClass: "far",
      bordersWith: [],
      navalExposure: { transportReachableOwnShoreTiles: 0 },
    })),
  };
  const boundedBase = boundedSpatialV5(observation);
  assert.ok(boundedBase);
  const minimap = {
    schemaVersion: 2,
    width: 32,
    height: 16,
    ownershipRows: Array.from({ length: 16 }, () => "A".repeat(32)),
    terrainRows: Array.from({ length: 16 }, () => ".".repeat(32)),
    legend: [{ glyph: "A", playerID: ownPlayerID, isYou: true }],
    markers: Array.from({ length: 24 }, (_, index) => ({
      type: "C",
      ownerPlayerID: ownPlayerID,
      x: index,
      y: 0,
    })),
    markersTotal: 96,
    markersReturned: 24,
    markersTruncated: true,
  };
  const boundedWithMinimap = boundedSpatialV5({
    ...observation,
    spatial: { ...observation.spatial, minimap },
  });
  assert.ok(boundedWithMinimap?.minimap);
  assert.ok(
    Buffer.byteLength(JSON.stringify(boundedBase), "utf8") <=
      OWNER_SPATIAL_SERIALIZED_MAX_BYTES,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(minimap), "utf8") <= 4 * 1024);
  assert.ok(
    Buffer.byteLength(JSON.stringify(boundedWithMinimap), "utf8") >
      OWNER_SPATIAL_SERIALIZED_MAX_BYTES,
  );

  const oversizedStageOne = structuredClone(observation);
  const replacementIDs = new Map([
    [ownPlayerID, "S".repeat(92)],
    ...rivalIDs.map((playerID, index) => [
      playerID,
      `${String.fromCharCode(65 + index).repeat(90)}${String(index).padStart(2, "0")}`,
    ]),
  ]);
  oversizedStageOne.ownState.playerID = replacementIDs.get(ownPlayerID);
  for (const player of oversizedStageOne.visiblePlayers) {
    player.playerID = replacementIDs.get(player.playerID);
  }
  for (const asset of [
    ...oversizedStageOne.spatial.positionedAssets.structures,
    ...oversizedStageOne.spatial.positionedAssets.warships,
  ]) {
    asset.ownerPlayerID = replacementIDs.get(asset.ownerPlayerID);
  }
  assert.equal(boundedSpatialV5(oversizedStageOne), null);
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

test("rich L4 naval exposure changes only the ranking of offered actions", () => {
  const observation = richSpatialObservationV5();
  observation.visiblePlayers.push({
    ...structuredClone(observation.visiblePlayers[0]),
    playerID: "P_B",
    bordersWith: [],
    navalExposure: { transportReachableOwnShoreTiles: 0 },
  });
  observation.spatial.positionedAssets.warships = [];
  observation.spatial.positionedAssets.warshipsTotal = 0;
  observation.spatial.positionedAssets.warshipsReturned = 0;
  observation.spatial.positionedAssets.warshipsTruncated = false;
  const actions = [
    { id: "attack:P_B", kind: "attack", metadata: { targetID: "P_B" } },
    { id: "attack:P_A", kind: "attack", metadata: { targetID: "P_A" } },
  ];
  const ranked = rankOfferedActionsWithSpatial(actions, observation);
  assert.equal(ranked[0], actions[1]);
  assert.deepEqual(new Set(ranked), new Set(actions));
  assert.equal(
    ranked.some((action) => "intent" in action),
    false,
  );
});

test("capability evidence is bounded, joinable, and contains no raw body", () => {
  const lines = [];
  const logEvidence = createOwnerCapabilityEvidenceLogger({
    emit: (line) => lines.push(line),
  });
  const body = "Hold the shared border exactly.";
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  const observation = {
    ...richSpatialObservationV5(),
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
          messageEventID: firstMessageEventID,
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
  assert.equal(observed.messageEventID, firstMessageEventID);
  assert.deepEqual(selected.offeredMessageActionIDs, [message.id]);
  assert.equal(selected.selectedMessageActionID, message.id);
  assert.equal(selected.selectedLegalActionOffered, true);
  const spatial = events.find((event) => event.kind === "spatial_observation");
  assert.ok(Number.isSafeInteger(spatial.baseSerializedUTF8Bytes));
  assert.ok(spatial.baseSerializedUTF8Bytes > 0);
  assert.ok(spatial.baseSerializedUTF8Bytes <= 16 * 1024);
  assert.ok(Number.isSafeInteger(spatial.minimapSerializedUTF8Bytes));
  assert.ok(spatial.minimapSerializedUTF8Bytes > 0);
  assert.ok(spatial.minimapSerializedUTF8Bytes <= 4 * 1024);
  assert.equal("serializedUTF8Bytes" in spatial, false);
});

test("capability evidence capacity covers the complete supported horizon", () => {
  assert.equal(OWNER_EVIDENCE_SUPPORTED_MAX_DECISION_STEPS, 600);
  assert.equal(OWNER_EVIDENCE_MAX_INBOUND_MESSAGES_PER_STEP, 8);
  assert.deepEqual(OWNER_EVIDENCE_MAX_EVENTS_BY_KIND, {
    deal_selection: OWNER_EVIDENCE_SUPPORTED_MAX_DECISION_STEPS,
    message_selection: OWNER_EVIDENCE_SUPPORTED_MAX_DECISION_STEPS,
    message_observation:
      OWNER_EVIDENCE_SUPPORTED_MAX_DECISION_STEPS *
      OWNER_EVIDENCE_MAX_INBOUND_MESSAGES_PER_STEP,
    spatial_observation: 1,
  });
});

test("capability evidence retains observations beyond the old sample cap", () => {
  const lines = [];
  const logEvidence = createOwnerCapabilityEvidenceLogger({
    emit: (line) => lines.push(line),
  });
  for (let offset = 0; offset < 65; offset += 8) {
    const inboundMessages = Array.from(
      { length: Math.min(8, 65 - offset) },
      (_, localIndex) => {
        const index = offset + localIndex + 1;
        const senderIndex = localIndex % 3;
        return {
          messageEventID: `msg_00000000-0000-4000-8000-${index
            .toString(16)
            .padStart(12, "0")}`,
          senderID: ["P_B", "P_C", "P_D"][senderIndex],
          senderName: ["Rival B", "Rival C", "Rival D"][senderIndex],
          turnNumber: index,
          text: `message ${index}`,
        };
      },
    );
    logEvidence({
      requestID: `req_${offset}`,
      slot: 0,
      actions: [primary],
      observation: {
        ownState: { playerID: "P_A" },
        visiblePlayers: [],
        nonCombat: { inboundMessages },
      },
      response: { selectedLegalActionId: primary.id },
    });
  }
  const events = lines.map((line) =>
    JSON.parse(line.replace("PROXYWAR_OWNER_CAPABILITY_EVIDENCE ", "")),
  );
  assert.equal(
    events.filter((event) => event.kind === "message_observation").length,
    65,
  );
  assert.equal(
    events.some((event) => event.kind === OWNER_EVIDENCE_SATURATION_KIND),
    false,
  );
});

test("capability evidence emits one explicit marker when a kind saturates", () => {
  const lines = [];
  const logEvidence = createOwnerCapabilityEvidenceLogger({
    emit: (line) => lines.push(line),
    maxEventsByKind: {
      deal_selection: 1,
      message_selection: 1,
      message_observation: 1,
      spatial_observation: 1,
    },
  });
  const evidenceInput = (requestID, messageEventID) => ({
    requestID,
    slot: 0,
    actions: [primary, deal, message],
    observation: {
      ownState: { playerID: "P_A" },
      visiblePlayers: [],
      nonCombat: {
        inboundMessages: [
          {
            messageEventID,
            senderID: "P_B",
            senderName: "Rival B",
            turnNumber: 7,
            text: "bounded evidence",
          },
        ],
      },
    },
    response: {
      selectedLegalActionId: primary.id,
      selectedDealActionId: deal.id,
      selectedMessageActionId: message.id,
      messageText: "bounded evidence",
    },
  });
  logEvidence(evidenceInput("req_1", firstMessageEventID));
  logEvidence(evidenceInput("req_2", secondMessageEventID));
  logEvidence(
    evidenceInput(
      "req_3",
      "msg_00000000-0000-4000-8000-000000000003",
    ),
  );

  const events = lines.map((line) =>
    JSON.parse(line.replace("PROXYWAR_OWNER_CAPABILITY_EVIDENCE ", "")),
  );
  const saturated = events.filter(
    (event) => event.kind === OWNER_EVIDENCE_SATURATION_KIND,
  );
  assert.deepEqual(
    saturated.map((event) => event.saturatedKind).sort(),
    ["deal_selection", "message_observation", "message_selection"],
  );
  assert.ok(saturated.every((event) => event.maximum === 1));
});

test("capability evidence retries a saturation marker after emit failure", () => {
  const lines = [];
  let saturationAttempts = 0;
  const logEvidence = createOwnerCapabilityEvidenceLogger({
    emit: (line) => {
      const event = JSON.parse(
        line.replace("PROXYWAR_OWNER_CAPABILITY_EVIDENCE ", ""),
      );
      if (
        event.kind === OWNER_EVIDENCE_SATURATION_KIND &&
        saturationAttempts++ === 0
      ) {
        throw new Error("injected saturation write failure");
      }
      lines.push(line);
    },
    maxEventsByKind: {
      deal_selection: 1,
      message_selection: 1,
      message_observation: 1,
      spatial_observation: 1,
    },
  });
  const args = {
    requestID: "req_saturation_retry",
    slot: 0,
    actions: [primary, deal],
    observation: { ownState: { playerID: "P_A" }, visiblePlayers: [] },
    response: {
      selectedLegalActionId: primary.id,
      selectedDealActionId: deal.id,
    },
    spawn: true,
  };
  logEvidence(args);
  logEvidence(args);
  logEvidence(args);
  logEvidence(args);

  const events = lines.map((line) =>
    JSON.parse(line.replace("PROXYWAR_OWNER_CAPABILITY_EVIDENCE ", "")),
  );
  assert.equal(saturationAttempts, 2);
  assert.equal(
    events.filter(
      (event) => event.kind === OWNER_EVIDENCE_SATURATION_KIND,
    ).length,
    1,
  );
});

test("capability evidence retries the same inbound event after emit failure", () => {
  const lines = [];
  let observationAttempts = 0;
  const logEvidence = createOwnerCapabilityEvidenceLogger({
    emit: (line) => {
      const event = JSON.parse(
        line.replace("PROXYWAR_OWNER_CAPABILITY_EVIDENCE ", ""),
      );
      if (
        event.kind === "message_observation" &&
        observationAttempts++ === 0
      ) {
        throw new Error("injected observation write failure");
      }
      lines.push(line);
    },
  });
  const args = {
    requestID: "req_observation_retry",
    slot: 0,
    actions: [primary],
    observation: {
      ownState: { playerID: "P_A" },
      visiblePlayers: [],
      nonCombat: {
        inboundMessages: [
          {
            messageEventID: firstMessageEventID,
            senderID: "P_B",
            senderName: "Rival B",
            turnNumber: 7,
            text: "retry this exact observation",
          },
        ],
      },
    },
    response: { selectedLegalActionId: primary.id },
    spawn: true,
  };
  logEvidence(args);
  logEvidence(args);

  const observations = lines
    .map((line) =>
      JSON.parse(line.replace("PROXYWAR_OWNER_CAPABILITY_EVIDENCE ", "")),
    )
    .filter((event) => event.kind === "message_observation");
  assert.equal(observationAttempts, 2);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].messageEventID, firstMessageEventID);
});
