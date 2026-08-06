import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROADCAST_RAIL_LOCATE_EVENT,
  installCompetitorLocateBridge,
} from "../../../src/client/graphics/CompetitorLocateBridge";
import { GoToPlayerEvent } from "../../../src/client/graphics/TransformHandler";
import { EventBus } from "../../../src/core/EventBus";
import type { GameView, PlayerView } from "../../../src/core/game/GameView";

function makePlayer(clientID: string, name: string): PlayerView {
  return {
    clientID: () => clientID,
    displayName: () => name,
    name: () => name,
  } as unknown as PlayerView;
}

function makeGame(players: readonly PlayerView[]): GameView {
  return { playerViews: () => players } as unknown as GameView;
}

describe("installCompetitorLocateBridge", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves a rail click by clientID and emits exactly one GoToPlayerEvent — a one-shot locate, never persisted", () => {
    const auri = makePlayer("client-auri", "Auri Nation");
    const other = makePlayer("client-other", "Other Nation");
    const game = makeGame([other, auri]);
    const eventBus = new EventBus();
    const received: GoToPlayerEvent[] = [];
    eventBus.on(GoToPlayerEvent, (e) => received.push(e));

    installCompetitorLocateBridge(game, eventBus);

    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_LOCATE_EVENT, {
        detail: { playerName: "Auri", clientID: "client-auri" },
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].player).toBe(auri);
  });

  it("falls back to playerName resolution when clientID is absent", () => {
    const auri = makePlayer("client-auri", "Auri Nation");
    const game = makeGame([auri]);
    const eventBus = new EventBus();
    const received: GoToPlayerEvent[] = [];
    eventBus.on(GoToPlayerEvent, (e) => received.push(e));

    installCompetitorLocateBridge(game, eventBus);
    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_LOCATE_EVENT, {
        detail: { playerName: "Auri Nation", clientID: null },
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].player).toBe(auri);
  });

  it("emits nothing when neither clientID nor playerName resolves a real player — never throws, never fabricates a locate", () => {
    const game = makeGame([makePlayer("client-a", "A")]);
    const eventBus = new EventBus();
    const emit = vi.spyOn(eventBus, "emit");
    installCompetitorLocateBridge(game, eventBus);

    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_LOCATE_EVENT, {
        detail: { playerName: "Unknown", clientID: "client-ghost" },
      }),
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it("renders no DOM/UI of its own — a competitor click is a pure event-bus bridge, not a top-of-screen selector", () => {
    const game = makeGame([]);
    const eventBus = new EventBus();
    installCompetitorLocateBridge(game, eventBus);
    expect(document.querySelector("pov-selector")).toBeNull();
    expect(document.querySelector("[data-pov-toolbar]")).toBeNull();
  });

  it("REGRESSION: installing for a second game (a re-mount) removes/invalidates the first — a click emits on the new game's bus only, never the old one, and never twice", () => {
    const playerA = makePlayer("client-a", "Nation A");
    const gameA = makeGame([playerA]);
    const eventBusA = new EventBus();
    const receivedA: GoToPlayerEvent[] = [];
    eventBusA.on(GoToPlayerEvent, (e) => receivedA.push(e));
    installCompetitorLocateBridge(gameA, eventBusA);

    const playerB = makePlayer("client-a", "Nation A (re-mounted)");
    const gameB = makeGame([playerB]);
    const eventBusB = new EventBus();
    const receivedB: GoToPlayerEvent[] = [];
    eventBusB.on(GoToPlayerEvent, (e) => receivedB.push(e));
    installCompetitorLocateBridge(gameB, eventBusB);

    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_LOCATE_EVENT, {
        detail: { playerName: null, clientID: "client-a" },
      }),
    );

    // One click, one document listener alive (the B install tore down A's
    // before this dispatch) -> exactly one emission, on B's bus, resolved
    // against B's GameView; A's stale bus/game never sees it at all.
    expect(receivedB).toHaveLength(1);
    expect(receivedB[0].player).toBe(playerB);
    expect(receivedA).toHaveLength(0);
  });

  it("the returned disposer removes the listener and is a no-op if a later install already superseded it", () => {
    const playerA = makePlayer("client-a", "Nation A");
    const eventBusA = new EventBus();
    const receivedA: GoToPlayerEvent[] = [];
    eventBusA.on(GoToPlayerEvent, (e) => receivedA.push(e));
    const disposeA = installCompetitorLocateBridge(
      makeGame([playerA]),
      eventBusA,
    );

    disposeA();
    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_LOCATE_EVENT, {
        detail: { playerName: null, clientID: "client-a" },
      }),
    );
    expect(receivedA).toHaveLength(0);

    // A stale disposer from an already-superseded install must never tear
    // down a NEWER install it doesn't own.
    const playerB = makePlayer("client-b", "Nation B");
    const eventBusB = new EventBus();
    const receivedB: GoToPlayerEvent[] = [];
    eventBusB.on(GoToPlayerEvent, (e) => receivedB.push(e));
    installCompetitorLocateBridge(makeGame([playerB]), eventBusB);
    disposeA(); // stale — must not remove B's live listener
    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_LOCATE_EVENT, {
        detail: { playerName: null, clientID: "client-b" },
      }),
    );
    expect(receivedB).toHaveLength(1);
  });
});
