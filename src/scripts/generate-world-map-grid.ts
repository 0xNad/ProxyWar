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
 * there). Every land tile joins the theatre of its nearest nation seed —
 * the World manifest's own nations, each assigned to the theatre whose
 * battlefield maps contain it, plus a few extra seeds — measured from a
 * noise-warped point so borders meander like real ones. Islands join one
 * theatre whole, and a majority filter smooths stray tiles.
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

/**
 * Theatre of each nation in the World map's own manifest. Membership follows
 * the nations each theatre's battlefield maps contain (e.g. the Oceania map
 * includes Thailand and Indonesia; the Black Sea map Türkiye, Ukraine and
 * Romania). `null` nations (Antarctica) lie south of the crop.
 */
const NATION_THEATRES: Record<string, Code | null> = {
  "United States": "a",
  Canada: "a",
  Mexico: "a",
  Cuba: "a",
  Greenland: "a",
  Alaska: "a",
  Yukon: "a",
  California: "a",
  Texas: "a",
  Quebec: "a",
  Nunavut: "a",
  Colombia: "b",
  Venezuela: "b",
  Argentina: "b",
  Brazil: "b",
  Peru: "b",
  Uruguay: "b",
  Bolivia: "b",
  "United Kingdom": "c",
  Ireland: "c",
  Iceland: "d",
  Spain: "d",
  Italy: "d",
  France: "d",
  Germany: "d",
  Sweden: "d",
  Poland: "d",
  Norway: "d",
  Finland: "d",
  Latvia: "d",
  Belarus: "d",
  Romania: "e",
  Türkiye: "e",
  Ukraine: "e",
  Iran: "f",
  "Saudi Arabia": "f",
  Oman: "f",
  Algeria: "g",
  Libya: "g",
  Egypt: "g",
  Niger: "g",
  Sudan: "g",
  "DR Congo": "g",
  Ethiopia: "g",
  "South Africa": "g",
  Madagascar: "g",
  Chad: "g",
  Namibia: "g",
  Zambia: "g",
  Morocco: "g",
  Benin: "g",
  Senegal: "g",
  Kenya: "g",
  Russia: "h",
  Siberia: "h",
  Mongolia: "h",
  Kazakhstan: "h",
  India: "h",
  Bhutan: "h",
  Pakistan: "h",
  "Sri Lanka": "h",
  China: "i",
  Japan: "i",
  Taiwan: "i",
  Australia: "j",
  "New Zealand": "j",
  Indonesia: "j",
  Philippines: "j",
  Thailand: "j",
  Antarctica: null,
  "West Antarctica": null,
  "East Antarctica": null,
};

/**
 * Extra seeds (longitude, latitude) where the manifest's nations alone would
 * draw a border through the wrong country: the Levant, Mesopotamia and
 * Yemen; Somalia; Korea and Manchuria; Russia's Pacific coast; the Caucasus
 * and Bulgaria; European Russia and the Balkans.
 */
const EXTRA_SEEDS: ReadonlyArray<readonly [number, number, Code]> = [
  [44, 33, "f"],
  [38, 34.5, "f"],
  [48.5, 16.5, "f"],
  [46, 6, "g"],
  [140, 60, "h"],
  [158, 59, "h"],
  [172, 66, "h"],
  [127.5, 37.5, "i"],
  [126, 45, "i"],
  [114, 24, "i"],
  [44, 42, "e"],
  [25.5, 42.7, "e"],
  [40, 56, "d"],
  [50, 58, "d"],
  [20.5, 44, "d"],
  [22, 39.5, "d"],
];

/** Seeds that claim only the island they stand on (no mainland Brittany). */
const ISLAND_ONLY = new Set(["United Kingdom", "Ireland"]);

/** Smooth, deterministic value noise in [-1, 1]. */
function noise(x: number, y: number, scale: number, salt: number): number {
  const hash = (ix: number, iy: number) => {
    let h =
      Math.imul(ix, 374761393) +
      Math.imul(iy, 668265263) +
      Math.imul(salt, 362437);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const gx = x / scale;
  const gy = y / scale;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * sx;
  const bottom =
    hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * sx;
  return (top + (bottom - top) * sy) * 2 - 1;
}

/** Warped sample point, so borders between seeds meander like real ones. */
function warp(x: number, y: number): readonly [number, number] {
  return [
    x + 4.5 * noise(x, y, 14, 1) + 1.8 * noise(x, y, 5, 2),
    y + 4.5 * noise(x, y, 14, 3) + 1.8 * noise(x, y, 5, 4),
  ];
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
  const latOf = (y: number) => latOfPixel((y + 0.5) * SOURCE_SCALE);
  const rows: number[] = [];
  for (let y = 0; y < SOURCE_HEIGHT; y++) {
    if (latOf(y) >= LAT_BOTTOM) rows.push(y);
  }
  const width = SOURCE_WIDTH;
  const height = rows.length;
  const isLand = (x: number, y: number) =>
    (bytes[rows[y] * SOURCE_WIDTH + x] & 0x80) !== 0;

  // Land masses (4-connected), so island-only seeds stay on their islands.
  const component = new Int32Array(width * height).fill(-1);
  const componentSize: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (component[start] !== -1) continue;
    if (!isLand(start % width, Math.floor(start / width))) continue;
    const id = componentSize.length;
    const stack = [start];
    component[start] = id;
    let size = 0;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      size++;
      const x = i % width;
      const y = Math.floor(i / width);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (component[n] !== -1 || !isLand(nx, ny)) continue;
        component[n] = id;
        stack.push(n);
      }
    }
    componentSize.push(size);
  }
  /** Islands only: Great Britain and Ireland, never the continents. */
  const ISLAND_MAX_TILES = 2500;

  const manifest = JSON.parse(
    readFileSync(path.join(root, "resources/maps/world/manifest.json"), "utf8"),
  ) as { nations: { name: string; coordinates: [number, number] }[] };
  interface Seed {
    readonly x: number;
    readonly y: number;
    readonly code: Code;
    readonly islandOnly: boolean;
  }
  const seeds: Seed[] = [];
  for (const nation of manifest.nations) {
    if (!(nation.name in NATION_THEATRES)) {
      throw new Error(`nation ${nation.name} has no theatre assignment`);
    }
    const code = NATION_THEATRES[nation.name];
    if (code === null) continue;
    seeds.push({
      x: nation.coordinates[0] / SOURCE_SCALE,
      y: nation.coordinates[1] / SOURCE_SCALE,
      code,
      islandOnly: ISLAND_ONLY.has(nation.name),
    });
  }
  for (const [lon, lat, code] of EXTRA_SEEDS) {
    seeds.push({
      x: (PROJECTION.ax * lon + PROJECTION.bx) / SOURCE_SCALE,
      y: (PROJECTION.ay * lat + PROJECTION.by) / SOURCE_SCALE,
      code,
      islandOnly: false,
    });
  }

  // Every land tile joins its nearest seed, measured from a warped point so
  // borders meander instead of running as straight Voronoi edges.
  let grid: (Code | ".")[][] = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      if (!isLand(x, y)) return ".";
      const onIsland =
        componentSize[component[y * width + x]] <= ISLAND_MAX_TILES;
      const [wx, wy] = warp(x + 0.5, rows[y] + 0.5);
      let best: Seed | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const seed of seeds) {
        if (seed.islandOnly && !onIsland) continue;
        const distance = (seed.x - wx) ** 2 + (seed.y - wy) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = seed;
        }
      }
      return (best as Seed).code;
    }),
  );
  // An island belongs to one front: the theatre most of its tiles chose.
  const islandVotes = new Map<number, Map<Code, number>>();
  grid.forEach((row, y) =>
    row.forEach((cell, x) => {
      const id = component[y * width + x];
      if (cell === "." || componentSize[id] > ISLAND_MAX_TILES) return;
      const votes = islandVotes.get(id) ?? new Map<Code, number>();
      votes.set(cell, (votes.get(cell) ?? 0) + 1);
      islandVotes.set(id, votes);
    }),
  );
  const islandCode = new Map<number, Code>();
  for (const [id, votes] of islandVotes) {
    const ranked = [...votes].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    );
    islandCode.set(id, ranked[0][0]);
  }
  grid = grid.map((row, y) =>
    row.map((cell, x) =>
      cell === "." ? cell : (islandCode.get(component[y * width + x]) ?? cell),
    ),
  );
  // Two majority passes smooth single-tile speckles out of the borders.
  for (let pass = 0; pass < 2; pass++) {
    grid = grid.map((row, y) =>
      row.map((cell, x) => {
        if (cell === ".") return cell;
        const votes = new Map<Code, number>();
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny < 0 || nx < 0 || ny >= height || nx >= width) continue;
            const neighbour = grid[ny][nx];
            if (neighbour === ".") continue;
            if (component[ny * width + nx] !== component[y * width + x])
              continue;
            votes.set(neighbour, (votes.get(neighbour) ?? 0) + 1);
          }
        }
        let winner: Code = cell;
        let most = votes.get(cell) ?? 0;
        for (const [code, count] of votes) {
          if (count > most + 2) {
            winner = code;
            most = count;
          }
        }
        return winner;
      }),
    );
  }
  const encodedRows = grid.map((row) => {
    let out = "";
    for (let x = 0; x < row.length; ) {
      let run = 1;
      while (x + run < row.length && row[x + run] === row[x]) run++;
      out += (run > 1 ? String(run) : "") + row[x];
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
