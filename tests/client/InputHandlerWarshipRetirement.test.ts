import { describe, expect, it } from "vitest";
import {
  InputHandler,
  SelectAllWarshipsEvent,
} from "../../src/client/InputHandler";
import { UIState } from "../../src/client/graphics/UIState";
import { EventBus } from "../../src/core/EventBus";
import { UnitType } from "../../src/core/game/Game";
import { GameView } from "../../src/core/game/GameView";

function makeHandler(warshipsDisabled: boolean) {
  const eventBus = new EventBus();
  const uiState: UIState = {
    attackRatio: 0.2,
    ghostStructure: null,
    overlappingRailroads: [],
    ghostRailPaths: [],
    rocketDirectionUp: true,
  };
  const gameView = {
    config: () => ({
      isUnitDisabled: (unit: UnitType) =>
        unit === UnitType.Warship && warshipsDisabled,
    }),
    inSpawnPhase: () => false,
    myPlayer: () => ({ isAlive: () => true }),
  } as unknown as GameView;
  const canvas = document.createElement("canvas");
  const handler = new InputHandler(gameView, uiState, canvas, eventBus);
  handler.initialize();
  return { canvas, eventBus, uiState };
}

describe("InputHandler retired Warship controls", () => {
  it("ignores Warship hotkeys in new games and preserves historical configs", () => {
    const current = makeHandler(true);
    const historical = makeHandler(false);
    let currentSelectAll = 0;
    let historicalSelectAll = 0;
    current.eventBus.on(SelectAllWarshipsEvent, () => currentSelectAll++);
    historical.eventBus.on(SelectAllWarshipsEvent, () => historicalSelectAll++);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyF" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Digit7" }));

    expect(current.canvas.style.cursor).toBe("");
    expect(historical.canvas.style.cursor).toBe("crosshair");
    expect(currentSelectAll).toBe(0);
    expect(current.uiState.ghostStructure).toBeNull();
    expect(historicalSelectAll).toBe(1);
    expect(historical.uiState.ghostStructure).toBe(UnitType.Warship);
  });
});
