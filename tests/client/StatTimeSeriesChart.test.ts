import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeChartGeometry,
  renderTimeSeriesChart,
  type TimeSeriesPoint,
} from "../../src/client/StatTimeSeriesChart";
import type * as UtilsModule from "../../src/client/Utils";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof UtilsModule>()),
  translateText: (key: string) => key,
}));

function mountedContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("computeChartGeometry", () => {
  it("returns empty geometry for an empty series", () => {
    expect(computeChartGeometry([], null)).toEqual({
      plotted: [],
      yMin: 0,
      yMax: 0,
      path: "",
    });
  });

  it("plots a single point centered horizontally, never dividing by zero", () => {
    const points: TimeSeriesPoint[] = [{ at: "2026-07-01", value: 0.5 }];
    const geometry = computeChartGeometry(points, [0, 1]);
    expect(geometry.plotted).toHaveLength(1);
    expect(Number.isFinite(geometry.plotted[0].x)).toBe(true);
    expect(Number.isFinite(geometry.plotted[0].y)).toBe(true);
  });

  it("plots points left to right in input order, spanning the full inner width", () => {
    const points: TimeSeriesPoint[] = [
      { at: "2026-07-01", value: 0 },
      { at: "2026-07-02", value: 0.5 },
      { at: "2026-07-03", value: 1 },
    ];
    const geometry = computeChartGeometry(points, [0, 1]);
    expect(geometry.plotted[0].x).toBeLessThan(geometry.plotted[1].x);
    expect(geometry.plotted[1].x).toBeLessThan(geometry.plotted[2].x);
    // A higher value plots higher on screen (smaller y in SVG coordinates).
    expect(geometry.plotted[2].y).toBeLessThan(geometry.plotted[0].y);
  });

  it("auto-fits the y-domain to the data's own min/max when no fixed domain is given", () => {
    const points: TimeSeriesPoint[] = [
      { at: "2026-07-01", value: 10 },
      { at: "2026-07-02", value: 40 },
    ];
    const geometry = computeChartGeometry(points, null);
    expect(geometry.yMin).toBe(10);
    expect(geometry.yMax).toBe(40);
  });

  it("never produces NaN geometry for a perfectly flat series", () => {
    const points: TimeSeriesPoint[] = [
      { at: "2026-07-01", value: 5 },
      { at: "2026-07-02", value: 5 },
    ];
    const geometry = computeChartGeometry(points, null);
    for (const point of geometry.plotted) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it("produces a valid SVG path string with one command per point", () => {
    const points: TimeSeriesPoint[] = [
      { at: "2026-07-01", value: 0 },
      { at: "2026-07-02", value: 1 },
      { at: "2026-07-03", value: 0.5 },
    ];
    const geometry = computeChartGeometry(points, [0, 1]);
    expect(geometry.path.startsWith("M")).toBe(true);
    expect(geometry.path.match(/L/g)).toHaveLength(2);
  });
});

describe("renderTimeSeriesChart", () => {
  const baseProps = {
    yDomain: [0, 1] as [number, number],
    formatValue: (value: number) => `${Math.round(value * 100)}%`,
    formatX: (at: string) => at,
    color: "var(--pw-accent)",
    ariaLabel: "Winrate over time",
    captionText: "test methodology",
    tableCaption: "Winrate data table",
    columnValueLabel: "Winrate",
  };

  it("renders nothing for an empty series", () => {
    const container = mountedContainer();
    render(renderTimeSeriesChart({ ...baseProps, points: [] }), container);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders an accessible svg with role=img and a real aria-label", () => {
    const container = mountedContainer();
    render(
      renderTimeSeriesChart({
        ...baseProps,
        points: [
          { at: "2026-07-01", value: 0.5 },
          { at: "2026-07-02", value: 0.6 },
        ],
      }),
      container,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Winrate over time");
  });

  it("renders one circle per point and a native tooltip title on each", () => {
    const container = mountedContainer();
    render(
      renderTimeSeriesChart({
        ...baseProps,
        points: [
          { at: "2026-07-01", value: 0.5 },
          { at: "2026-07-02", value: 0.6 },
          { at: "2026-07-03", value: 0.7 },
        ],
      }),
      container,
    );
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(3);
    expect(circles[0].querySelector("title")?.textContent).toContain("50%");
  });

  it("makes each point focusable and pairs it with a visible tooltip text sibling — a tap-accessible readout, since native SVG <title> alone never fires on touch (P3-04, 2026-08-02)", () => {
    const container = mountedContainer();
    render(
      renderTimeSeriesChart({
        ...baseProps,
        points: [
          { at: "2026-07-01", value: 0.5 },
          { at: "2026-07-02", value: 0.6 },
        ],
      }),
      container,
    );
    const circles = container.querySelectorAll("circle");
    for (const circle of circles) {
      expect(circle.getAttribute("tabindex")).toBe("0");
      const tooltip = circle.nextElementSibling;
      expect(tooltip?.tagName.toLowerCase()).toBe("text");
      expect(tooltip?.classList.contains("stat-chart-point-tooltip")).toBe(
        true,
      );
    }
    expect(circles[0].nextElementSibling?.textContent).toContain("50%");
    expect(circles[1].nextElementSibling?.textContent).toContain("60%");
  });

  it("draws y-axis min/max value labels and x-axis first/last-date labels — a sparkline otherwise has no visible scale (P3-04, 2026-08-02)", () => {
    const container = mountedContainer();
    render(
      renderTimeSeriesChart({
        ...baseProps,
        points: [
          { at: "2026-07-01", value: 0.2 },
          { at: "2026-07-15", value: 0.5 },
          { at: "2026-07-30", value: 0.9 },
        ],
      }),
      container,
    );
    const labels = Array.from(
      container.querySelectorAll(".stat-chart-axis-label"),
      (el) => el.textContent?.trim(),
    );
    // yDomain is fixed [0, 1] in baseProps, so min/max are the domain
    // bounds, not the data's own min/max.
    expect(labels).toContain("100%");
    expect(labels).toContain("0%");
    // formatX is the identity function in baseProps.
    expect(labels).toContain("2026-07-01");
    expect(labels).toContain("2026-07-30");
  });

  it("draws only one x-axis date label for a single-point series — never a duplicate", () => {
    const container = mountedContainer();
    render(
      renderTimeSeriesChart({
        ...baseProps,
        points: [{ at: "2026-07-01", value: 0.5 }],
      }),
      container,
    );
    const dateLabels = Array.from(
      container.querySelectorAll(".stat-chart-axis-label"),
      (el) => el.textContent?.trim(),
    ).filter((text) => text === "2026-07-01");
    expect(dateLabels).toHaveLength(1);
  });

  it("renders a version-marker line only for points that carry one", () => {
    const container = mountedContainer();
    render(
      renderTimeSeriesChart({
        ...baseProps,
        points: [
          { at: "2026-07-01", value: 0.5, marker: "v24 first observed" },
          { at: "2026-07-02", value: 0.6 },
        ],
      }),
      container,
    );
    expect(container.querySelectorAll("line.stat-chart-marker")).toHaveLength(1);
  });

  it("renders a collapsed data-table fallback with the same points, for keyboard/screen-reader access", () => {
    const container = mountedContainer();
    render(
      renderTimeSeriesChart({
        ...baseProps,
        points: [
          { at: "2026-07-01", value: 0.5 },
          { at: "2026-07-02", value: 0.6 },
        ],
      }),
      container,
    );
    const details = container.querySelector("details.stat-chart-table");
    expect(details).not.toBeNull();
    expect(details?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(details?.querySelector("thead th")?.textContent).toBe(
      "stat_chart.column_date",
    );
  });

  it("shows the caption text and the version-marker label in the table row", () => {
    const container = mountedContainer();
    render(
      renderTimeSeriesChart({
        ...baseProps,
        points: [{ at: "2026-07-01", value: 0.5, marker: "v24 first observed" }],
      }),
      container,
    );
    expect(container.querySelector(".stat-chart-caption")?.textContent).toBe(
      "test methodology",
    );
    expect(
      container.querySelector(".stat-chart-table-marker")?.textContent,
    ).toContain("v24 first observed");
  });
});
