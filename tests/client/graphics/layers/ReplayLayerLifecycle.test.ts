import { afterEach, describe, expect, it } from "vitest";
import {
  GoToPositionEvent,
  type TransformHandler,
} from "../../../../src/client/graphics/TransformHandler";
import { NationDossier } from "../../../../src/client/graphics/layers/NationDossier";
import { NukeCinema } from "../../../../src/client/graphics/layers/NukeCinema";
import { EventBus } from "../../../../src/core/EventBus";
import type { GameView } from "../../../../src/core/game/GameView";

describe("replay body-layer lifecycle", () => {
  afterEach(() => {
    document
      .querySelectorAll(".pw-dossier,.pw-nuke-cinema")
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
