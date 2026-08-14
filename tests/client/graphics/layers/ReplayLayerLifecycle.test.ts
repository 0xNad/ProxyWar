import { afterEach, describe, expect, it } from "vitest";
import type { TransformHandler } from "../../../../src/client/graphics/TransformHandler";
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
});
