/**
 * The pixel world's fitting, shared by the front page and `/world`: whole
 * tile widths near a multiple of the grid, and labels kept apart and on the
 * map. jsdom has no layout, so labels here report rectangles derived from
 * their position and the margins `separateLabels` writes.
 */
import { describe, expect, it } from "vitest";
import {
  pixelMapWidth,
  separateLabels,
} from "../../../src/client/publicapp/WorldMapLayout";

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

/** A label at (left, top) whose rectangle follows its margins. */
function label(left: number, top: number, width = 100, height = 30) {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    rect(
      left + (parseFloat(el.style.marginLeft) || 0),
      top + (parseFloat(el.style.marginTop) || 0),
      width,
      height,
    );
  return el;
}

describe("pixelMapWidth", () => {
  it("snaps to a whole multiple of the grid within 5%, never below double size", () => {
    expect(pixelMapWidth(1440, 500)).toBe(1500);
    expect(pixelMapWidth(1024, 500)).toBe(1000);
    expect(pixelMapWidth(1240, 500)).toBe(1240);
    // A single-scale map is never snapped: it would leave a wide margin.
    expect(pixelMapWidth(480, 500)).toBe(480);
    expect(pixelMapWidth(390, 500)).toBe(390);
  });
});

describe("separateLabels", () => {
  const bounds = rect(0, 0, 1000, 400);

  it("moves a label that would cover one already placed down past it", () => {
    const first = label(100, 100);
    const second = label(150, 110);
    separateLabels([first, second], bounds);
    expect(first.style.marginTop).toBe("0px");
    // Below the first (100 + 30) with a 4 px gap.
    expect(second.style.marginTop).toBe("24px");
  });

  it("moves it up instead when down would leave the map", () => {
    const first = label(100, 340);
    const second = label(150, 350);
    separateLabels([first, second], bounds);
    expect(second.style.marginTop).toBe("-44px");
  });

  it("keeps labels inside the map and skips hidden ones", () => {
    const edge = label(950, 50);
    const hidden = label(0, 0, 0, 0);
    separateLabels([hidden, edge], bounds);
    expect(edge.style.marginLeft).toBe("-58px");
    expect(hidden.style.marginLeft).toBe("0px");
  });

  it("starts from scratch every time, so a resize never compounds offsets", () => {
    const first = label(100, 100);
    const second = label(150, 110);
    separateLabels([first, second], bounds);
    separateLabels([first, second], bounds);
    expect(second.style.marginTop).toBe("24px");
  });
});
