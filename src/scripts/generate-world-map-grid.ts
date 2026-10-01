import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

/**
 * Generates `src/client/publicapp/WorldMapGrid.ts`: the `/world` page's
 * Earth, cut into league theatres.
 *
 * Source: the game's own World map at 1/16 scale
 * (`resources/maps/world/map16x.bin`, 500×250 tiles, bit 7 = land — see
 * `GameMap.ts`). The map is a stretched equirectangular projection that is
 * NOT aligned to -180°..180°: fitted by least squares against 20 nation
 * spawn points in `resources/maps/world/manifest.json` (residuals mostly
 * under 1.5°), full-size pixels are `x = 5.5554·lon + 934.39` and
 * `y = -6.1961·lat + 514.07` (2000×1000), i.e. -168°..192° and 83°N..78°S.
 * Rows south of 58°S are cropped (no Antarctica: no league map is fought
 * there). Every land tile is
 * assigned to one theatre by the longitude/latitude rules below — chosen
 * so each theatre covers roughly the ground its league battlefield shows —
 * and leftovers (small islands the rules miss) join the nearest theatre.
 *
 *   npx tsx src/scripts/generate-world-map-grid.ts
 *
 * The output is committed; rerun only when the rules or the source map
 * change. Deterministic: same inputs, same bytes.
 */

const SOURCE_WIDTH = 500;
const SOURCE_HEIGHT = 250;
/** Full-size World map pixels per 1/16-scale tile, per axis. */
const SOURCE_SCALE = 4;
const PROJECTION = { ax: 5.5554, bx: 934.39, ay: -6.1961, by: 514.07 };
const LAT_BOTTOM = -58;

/**
 * Where each theatre's label sits (longitude, latitude). Small theatres are
 * anchored just offshore so their labels do not cover their neighbours'.
 */
const LABEL_ANCHORS: Record<string, readonly [number, number]> = {
  north_america: [-100, 43],
  south_america: [-60, -13],
  britannia: [-21, 59],
  europe: [5, 47.5],
  black_sea: [41, 42],
  middle_east: [48, 26],
  africa: [20, 4],
  asia: [95, 57],
  east_asia: [126, 33],
  oceania: [134, -24],
  crown: [-142, -14],
};

function lonOfPixel(fullX: number): number {
  const lon = (fullX - PROJECTION.bx) / PROJECTION.ax;
  return lon > 180 ? lon - 360 : lon;
}

function latOfPixel(fullY: number): number {
  return (fullY - PROJECTION.by) / PROJECTION.ay;
}

/** Grid letters, in `WORLD_REGION_THEATRES` order. */
const THEATRE_CODES = [
  ["a", "north_america"],
  ["b", "south_america"],
  ["c", "britannia"],
  ["d", "europe"],
  ["e", "black_sea"],
  ["f", "middle_east"],
  ["g", "africa"],
  ["h", "asia"],
  ["i", "east_asia"],
  ["j", "oceania"],
] as const;

type Code = (typeof THEATRE_CODES)[number][0];

function theatreAt(lon: number, lat: number): Code | null {
  // The Americas, plus Greenland.
  if (lon < -30 || (lat > 67 && lon < -10)) {
    return (lat < 13 && lon > -79) || lat < 7.5 ? "b" : "a";
  }
  // The British Isles.
  if (lon >= -11 && lon < 2.2 && lat >= 49.8 && lat < 61) return "c";
  // Australia, New Zealand, maritime Southeast Asia and the Philippines.
  if (lat < -10 && lon > 110) return "j";
  if (lon >= 94 && lat < 8 && lat >= -11) return "j";
  if (lon >= 116 && lon < 128 && lat >= 4 && lat < 21) return "j";
  // Eastern China, Korea, Japan, Taiwan.
  if (lon >= 108 && lat >= 18 && lat < 46) return "i";
  // The Black Sea basin: Bulgaria, Romania, Ukraine, Turkey, the Caucasus.
  if (lon >= 22 && lon < 29 && lat >= 41.2 && lat < 52) return "e";
  if (lon >= 29 && lon < 46 && lat >= 40 && lat < 52) return "e";
  if (lon >= 26 && lon < 45 && lat >= 36.8 && lat < 40) return "e";
  if (lon >= 40 && lon < 50.5 && lat >= 38.8 && lat < 44) return "e";
  // Europe, Iceland and Svalbard; Crete.
  if (lon >= -25 && lon < 40 && lat >= 36.5) return "d";
  if (lon >= 19 && lon < 29 && lat >= 34.5 && lat < 36.5) return "d";
  // Africa and Arabia split along the Red Sea and Sinai.
  if (lat < 37.5 && lon >= -25 && lon < 55) {
    if (lat < 12) return lon < 52 ? "g" : null;
    if (lat < 22) return lon < 42 ? "g" : "f";
    if (lat < 31.7) return lon < 35.5 ? "g" : "f";
    return lon < 32 ? "g" : "f";
  }
  // Iraq, Iran and the Gulf.
  if (lon >= 35 && lon < 63 && lat >= 12 && lat < 40) return "f";
  // The rest of Asia: Siberia, Central and South Asia, Indochina.
  if (lon >= 40) return "h";
  return null;
}

async function main(): Promise<void> {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const bytes = readFileSync(
    path.join(root, "resources/maps/world/map16x.bin"),
  );
  if (bytes.length !== SOURCE_WIDTH * SOURCE_HEIGHT) {
    throw new Error(`unexpected map16x size ${bytes.length}`);
  }
  const lonOf = (x: number) => lonOfPixel((x + 0.5) * SOURCE_SCALE);
  const latOf = (y: number) => latOfPixel((y + 0.5) * SOURCE_SCALE);
  const rows: number[] = [];
  for (let y = 0; y < SOURCE_HEIGHT; y++) {
    if (latOf(y) >= LAT_BOTTOM) rows.push(y);
  }
  const width = SOURCE_WIDTH;
  const height = rows.length;
  const grid: (Code | "." | "?")[][] = rows.map((y) =>
    Array.from({ length: width }, (_, x) => {
      const land = (bytes[y * SOURCE_WIDTH + x] & 0x80) !== 0;
      if (!land) return ".";
      return theatreAt(lonOf(x), latOf(y)) ?? "?";
    }),
  );
  // Leftover land joins the nearest assigned tile (breadth-first, wrapping
  // east-west like the map itself).
  const queue: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y][x];
      if (cell !== "." && cell !== "?") queue.push([x, y]);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = (x + dx + width) % width;
      const ny = y + dy;
      if (ny < 0 || ny >= height || grid[ny][nx] !== "?") continue;
      grid[ny][nx] = grid[y][x];
      queue.push([nx, ny]);
    }
  }
  const encodedRows = grid.map((row) => {
    let out = "";
    for (let x = 0; x < row.length; ) {
      let run = 1;
      while (x + run < row.length && row[x + run] === row[x]) run++;
      // A tile still "?" here is isolated from every theatre; draw it as sea.
      const cell = row[x] === "?" ? "." : row[x];
      out += (run > 1 ? String(run) : "") + cell;
      x += run;
    }
    return out;
  });
  const counts = new Map<string, number>();
  for (const row of grid) {
    for (const cell of row) counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  const anchors = Object.entries(LABEL_ANCHORS).map(([id, [lon, lat]]) => {
    const fullX =
      PROJECTION.ax * (lon < lonOfPixel(0) ? lon + 360 : lon) + PROJECTION.bx;
    const fullY = PROJECTION.ay * lat + PROJECTION.by;
    const x = (fullX / SOURCE_SCALE / width) * 100;
    const y = ((fullY / SOURCE_SCALE - rows[0]) / height) * 100;
    return `  ${id}: { x: ${x.toFixed(2)}, y: ${y.toFixed(2)} },`;
  });
  const toPercentX = (lon: number) =>
    ((PROJECTION.ax * (lon < lonOfPixel(0) ? lon + 360 : lon) + PROJECTION.bx) /
      SOURCE_SCALE /
      width) *
    100;
  const toPercentY = (lat: number) =>
    (((PROJECTION.ay * lat + PROJECTION.by) / SOURCE_SCALE - rows[0]) /
      height) *
    100;
  const meridians = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180]
    .map(toPercentX)
    .filter((x) => x > 0 && x < 100)
    .sort((a, b) => a - b)
    .map((x) => x.toFixed(2));
  const parallels = [60, 30, 0, -30]
    .map(toPercentY)
    .filter((y) => y > 0 && y < 100)
    .map((y) => y.toFixed(2));
  const equator = toPercentY(0).toFixed(2);
  const header = `// GENERATED by src/scripts/generate-world-map-grid.ts — do not edit by hand.
// Source: resources/maps/world/map16x.bin (${SOURCE_WIDTH}x${SOURCE_HEIGHT}), cropped at ${-LAT_BOTTOM}°S.
// Land tiles per theatre: ${THEATRE_CODES.map(([code, id]) => `${id} ${counts.get(code) ?? 0}`).join(", ")}.
`;
  const source = `${header}
/** Theatre id for each grid letter; \`.\` is sea. */
export const WORLD_GRID_THEATRES = {
${THEATRE_CODES.map(([code, id]) => `  ${code}: "${id}",`).join("\n")}
} as const;

export const WORLD_GRID_WIDTH = ${width};
export const WORLD_GRID_HEIGHT = ${height};

/** Label anchor per theatre, in percent of the grid's width/height. */
export const WORLD_GRID_ANCHORS = {
${anchors.join("\n")}
} as const;

/** Ocean graticule (every 30°), in percent of the grid's width/height. */
export const WORLD_GRID_GRATICULE = {
  meridians: [${meridians.join(", ")}],
  parallels: [${parallels.join(", ")}],
  equator: ${equator},
} as const;

/** Run-length rows ("12.3a" = 12 sea tiles then 3 North America tiles), joined by \`|\`. */
export const WORLD_GRID_RLE =
  ${JSON.stringify(encodedRows.join("|"))};
`;
  const outPath = path.join(root, "src/client/publicapp/WorldMapGrid.ts");
  // Written already formatted, so regenerating leaves `prettier --check` clean.
  const formatted = await format(source, {
    ...(await resolveConfig(outPath)),
    filepath: outPath,
  });
  writeFileSync(outPath, formatted);
  console.log(
    `wrote ${outPath} (${width}x${height}, ${formatted.length} bytes); ${[
      ...counts.entries(),
    ]
      .map(([code, count]) => `${code}=${count}`)
      .join(" ")}`,
  );
}

await main();
