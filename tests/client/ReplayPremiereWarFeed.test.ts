import { describe, expect, it } from "vitest";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../../src/core/game/GameUpdates";
import {
  MAX_WAR_EVENTS_PER_BATCH,
  PremiereWarFeedTracker,
  type PremiereWarNameResolver,
} from "../../src/client/ReplayPremiereWarFeed";

const NAMES_BY_SMALL_ID = new Map<number, string>([
  [1, "Iron Atlas"],
  [2, "Bastion"],
  [3, "Vantage"],
]);
const NAMES_BY_PLAYER_ID = new Map<string, string>([
  ["p1", "Iron Atlas"],
  ["p2", "Bastion"],
]);

const resolver: PremiereWarNameResolver = {
  bySmallId: (id) => NAMES_BY_SMALL_ID.get(id) ?? null,
  byPlayerId: (id) => NAMES_BY_PLAYER_ID.get(id) ?? null,
};

function update(
  partial: Partial<Record<GameUpdateType, unknown[]>>,
): GameUpdateViewData {
  const updates = Object.fromEntries(
    Object.values(GameUpdateType)
      .filter((value): value is GameUpdateType => typeof value === "number")
      .map((type) => [type, []]),
  ) as unknown as GameUpdateViewData["updates"];
  for (const [type, entries] of Object.entries(partial)) {
    (updates as unknown as Record<string, unknown[]>)[type] = entries;
  }
  return {
    tick: 10,
    updates,
    packedTileUpdates: new Uint32Array(),
    playerNameViewData: {},
  } as unknown as GameUpdateViewData;
}

function playerUpdate(
  smallID: number,
  outgoingAttacks: Array<{
    id: string;
    targetID: number;
    retreating?: boolean;
  }>,
) {
  return {
    type: GameUpdateType.Player,
    smallID,
    outgoingAttacks: outgoingAttacks.map((attack) => ({
      attackerID: smallID,
      targetID: attack.targetID,
      troops: 1000,
      id: attack.id,
      retreating: attack.retreating ?? false,
    })),
  };
}

describe("PremiereWarFeedTracker", () => {
  it("extracts the war itself: alliances, betrayals, conquests, emotes, chat", () => {
    const tracker = new PremiereWarFeedTracker();
    const events = tracker.extract(
      update({
        [GameUpdateType.AllianceRequestReply]: [
          {
            type: GameUpdateType.AllianceRequestReply,
            accepted: true,
            request: { requestorID: 1, recipientID: 2 },
          },
          {
            type: GameUpdateType.AllianceRequestReply,
            accepted: false,
            request: { requestorID: 2, recipientID: 3 },
          },
        ],
        [GameUpdateType.BrokeAlliance]: [
          { type: GameUpdateType.BrokeAlliance, traitorID: 2, betrayedID: 1 },
        ],
        [GameUpdateType.ConquestEvent]: [
          {
            type: GameUpdateType.ConquestEvent,
            conquerorId: "p1",
            conqueredId: "p2",
          },
        ],
        [GameUpdateType.Emoji]: [
          {
            type: GameUpdateType.Emoji,
            emoji: {
              message: "😡",
              senderID: 1,
              recipientID: 2,
              createdAt: 1,
            },
          },
        ],
        [GameUpdateType.DisplayChatEvent]: [
          // Quick chat fans one event out per player; only one entry lands.
          {
            type: GameUpdateType.DisplayChatEvent,
            key: "attack1",
            category: "attack",
            target: "p2",
            playerID: 1,
            isFrom: true,
            recipient: "p1",
          },
          {
            type: GameUpdateType.DisplayChatEvent,
            key: "attack1",
            category: "attack",
            target: "p2",
            playerID: 2,
            isFrom: true,
            recipient: "p1",
          },
        ],
      }),
      1200,
      resolver,
    );

    expect(events).toEqual([
      {
        kind: "betrayal",
        actor: "Bastion",
        target: "Iron Atlas",
        detail: null,
        turn: 1200,
      },
      {
        kind: "alliance",
        actor: "Iron Atlas",
        target: "Bastion",
        detail: null,
        turn: 1200,
      },
      {
        kind: "conquest",
        actor: "Iron Atlas",
        target: "Bastion",
        detail: null,
        turn: 1200,
      },
      {
        kind: "emote",
        actor: "Iron Atlas",
        target: "Bastion",
        detail: "😡",
        turn: 1200,
      },
      {
        kind: "chat",
        actor: "Iron Atlas",
        target: "Bastion",
        detail: "attack.attack1",
        turn: 1200,
      },
    ]);
  });

  it("surfaces each attack and nuke once, skipping retreats and neutral targets", () => {
    const tracker = new PremiereWarFeedTracker();
    const first = tracker.extract(
      update({
        [GameUpdateType.Player]: [
          playerUpdate(1, [
            { id: "atk-1", targetID: 2 },
            // Expansion into neutral land (unresolvable target): skipped.
            { id: "atk-2", targetID: 0 },
            // Retreating attacks are not new aggression.
            { id: "atk-3", targetID: 2, retreating: true },
          ]),
        ],
        [GameUpdateType.Unit]: [
          {
            type: GameUpdateType.Unit,
            unitType: "Atom Bomb",
            id: 77,
            ownerID: 2,
            isActive: true,
          },
          {
            type: GameUpdateType.Unit,
            unitType: "Warship",
            id: 78,
            ownerID: 2,
            isActive: true,
          },
        ],
      }),
      500,
      resolver,
    );
    expect(first).toEqual([
      {
        kind: "attack",
        actor: "Iron Atlas",
        target: "Bastion",
        detail: null,
        turn: 500,
      },
      {
        kind: "nuke",
        actor: "Bastion",
        target: null,
        detail: null,
        turn: 500,
      },
    ]);

    // The same entities re-delivered on a later snapshot stay silent.
    const second = tracker.extract(
      update({
        [GameUpdateType.Player]: [
          playerUpdate(1, [{ id: "atk-1", targetID: 2 }]),
        ],
        [GameUpdateType.Unit]: [
          {
            type: GameUpdateType.Unit,
            unitType: "Atom Bomb",
            id: 77,
            ownerID: 2,
            isActive: true,
          },
        ],
      }),
      520,
      resolver,
    );
    expect(second).toEqual([]);
  });

  it("caps a single batch at the per-batch ceiling", () => {
    const tracker = new PremiereWarFeedTracker();
    const floods = Array.from({ length: 40 }, (_, index) => ({
      type: GameUpdateType.BrokeAlliance,
      traitorID: 1,
      betrayedID: 2,
      allianceID: index,
    }));
    const events = tracker.extract(
      update({ [GameUpdateType.BrokeAlliance]: floods }),
      42,
      resolver,
    );
    expect(events).toHaveLength(MAX_WAR_EVENTS_PER_BATCH);
  });
});
