import { afterEach, describe, expect, it } from "vitest";
import {
  GoToPositionEvent,
  type TransformHandler,
} from "../../../../src/client/graphics/TransformHandler";
import { AttackingTroopsOverlay } from "../../../../src/client/graphics/layers/AttackingTroopsOverlay";
import { NameLayer } from "../../../../src/client/graphics/layers/NameLayer";
import { NationDossier } from "../../../../src/client/graphics/layers/NationDossier";
import { NukeCinema } from "../../../../src/client/graphics/layers/NukeCinema";
import { WinModal } from "../../../../src/client/graphics/layers/WinModal";
import { EventBus } from "../../../../src/core/EventBus";
import type { GameView } from "../../../../src/core/game/GameView";
import { UserSettings } from "../../../../src/core/game/UserSettings";

// Minimal GameView for layers whose init() only reads config/identity.
const nameLayerGameStub = {
  myPlayer: () => null,
  config: () => ({
    theme: () => ({}),
    isReplay: () => true,
    disableAlliances: () => false,
    allianceDuration: () => 300,
  }),
} as unknown as GameView;

describe("replay body-layer lifecycle", () => {
  afterEach(() => {
    document
      .querySelectorAll(".pw-dossier,.pw-nuke-cinema,[data-pw-layer]")
      .forEach((node) => node.remove());
    document.body.classList.remove("pw-dossier-on", "pw-nuke-active");
  });

  it("NationDossier removes its node and body claim idempotently", () => {
    const dossier = new NationDossier({} as GameView);
    dossier.init();
    document.body.classList.add("pw-dossier-on");

    dossier.dispose();
    dossier.dispose();

    expect(document.querySelector(".pw-dossier")).toBeNull();
    expect(document.body.classList.contains("pw-dossier-on")).toBe(false);
  });

  it("NukeCinema removes its node and active-stage claim idempotently", () => {
    const cinema = new NukeCinema(
      {} as GameView,
      new EventBus(),
      {} as TransformHandler,
    );
    cinema.init();
    document.body.classList.add("pw-nuke-active");

    cinema.dispose();
    cinema.dispose();

    expect(document.querySelector(".pw-nuke-cinema")).toBeNull();
    expect(document.body.classList.contains("pw-nuke-active")).toBe(false);
  });

  it("NameLayer.dispose removes exactly its own body container — the rewind ghost-label leak", () => {
    const bus = new EventBus();

    // dispose() before init() must be a no-op (Layer contract).
    new NameLayer(nameLayerGameStub, {} as TransformHandler, bus).dispose();

    // An in-place rewind builds a second renderer while the first still owns
    // its container; before the fix each rewind stranded the old one forever.
    const rewoundAway = new NameLayer(
      nameLayerGameStub,
      {} as TransformHandler,
      bus,
    );
    rewoundAway.init();
    const live = new NameLayer(nameLayerGameStub, {} as TransformHandler, bus);
    live.init();
    expect(document.querySelectorAll('[data-pw-layer="names"]').length).toBe(2);

    rewoundAway.dispose();
    rewoundAway.dispose();
    expect(document.querySelectorAll('[data-pw-layer="names"]').length).toBe(1);

    live.dispose();
    expect(document.querySelectorAll('[data-pw-layer="names"]').length).toBe(0);
  });

  it("AttackingTroopsOverlay.dispose removes its body container idempotently", () => {
    const bus = new EventBus();
    const overlay = new AttackingTroopsOverlay(
      {} as GameView,
      {} as TransformHandler,
      bus,
      new UserSettings(),
    );

    // Pre-init dispose must be a no-op.
    overlay.dispose();

    overlay.init();
    expect(
      document.querySelectorAll('[data-pw-layer="attacking-troops"]').length,
    ).toBe(1);

    overlay.dispose();
    overlay.dispose();
    expect(
      document.querySelectorAll('[data-pw-layer="attacking-troops"]').length,
    ).toBe(0);
  });

  it("WinModal.dispose re-hides the banner so a rewound match does not keep the old winner on screen", () => {
    const modal = new WinModal();
    modal.isVisible = true;

    modal.dispose();
    modal.dispose();

    expect(modal.isVisible).toBe(false);
  });

  it("NukeCinema does not restore a stale camera snapshot after viewer intent changes", () => {
    const eventBus = new EventBus();
    let epoch = 4;
    const transform = {
      userCameraIntentEpoch: () => epoch,
    } as unknown as TransformHandler;
    const cinema = new NukeCinema({} as GameView, eventBus, transform);
    const restores: GoToPositionEvent[] = [];
    eventBus.on(GoToPositionEvent, (event) => restores.push(event));
    const hooks = cinema as unknown as {
      cinema: {
        restore: {
          x: number;
          y: number;
          scale: number;
          intentEpoch: number;
        } | null;
      } | null;
      restoreCamera(): void;
    };
    hooks.cinema = {
      restore: { x: 100, y: 200, scale: 2, intentEpoch: epoch },
    };

    epoch++;
    hooks.restoreCamera();

    expect(restores).toHaveLength(0);
    expect(hooks.cinema.restore).toBeNull();
  });

  it("NukeCinema restores when no viewer camera intent occurred", () => {
    const eventBus = new EventBus();
    const transform = {
      userCameraIntentEpoch: () => 4,
    } as unknown as TransformHandler;
    const cinema = new NukeCinema({} as GameView, eventBus, transform);
    const restores: GoToPositionEvent[] = [];
    eventBus.on(GoToPositionEvent, (event) => restores.push(event));
    const hooks = cinema as unknown as {
      cinema: {
        restore: {
          x: number;
          y: number;
          scale: number;
          intentEpoch: number;
        } | null;
      };
      restoreCamera(): void;
    };
    hooks.cinema = {
      restore: { x: 100, y: 200, scale: 2, intentEpoch: 4 },
    };

    hooks.restoreCamera();

    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({ x: 100, y: 200, zoom: 2 });
  });
});
