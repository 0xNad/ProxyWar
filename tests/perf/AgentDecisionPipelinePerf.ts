import os from "os";
import { dirname } from "path";
import { fileURLToPath } from "url";

import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { LlmPromptBuilder } from "../../src/server/agents/LlmPromptBuilder";
import { setup } from "../util/Setup";

/**
 * Splits a decision step into SIMULATION time and AGENT-SIDE time.
 *
 * WHY NOT BENCHMARK.JS HERE, and why this file does its own timing: the first
 * version of this harness used a Benchmark suite, which hammered
 * `executeNextTick()` roughly 900,000 times against ONE mutable board that had no
 * agent intents. After the first few thousand ticks the engine had nothing left to
 * execute, so the measured "tick" was a dead board — and the observation arms then
 * ran against that same inert state. It also compared 100 GAME-WIDE ticks against
 * ONE seat's observation while calling the result a 16-seat decision step. Both
 * faults inflated the headline. This version:
 *
 *   - times EXACTLY one decision step's worth of ticks (100) per sample, on a
 *     board kept ACTIVE by real `AttackExecution`s between neighbours;
 *   - re-arms activity before each sample and ASSERTS the board is not inert, so
 *     a quiet engine fails the run instead of producing a flattering number;
 *   - measures ALL 16 seats' observation+menu+prompt, because that is what a
 *     decision step actually costs, and reports per-seat alongside it;
 *   - reports ratios first, since absolute ms move with host load.
 *
 * Run: `npm run perf`, or
 * `npx tsx tests/perf/AgentDecisionPipelinePerf.ts`.
 */

const SEATS = 16;
const TILES_PER_SEAT = 1_200;
/** `tournament-16p-*` cadence: one decision step is this many engine ticks. */
const TURNS_PER_DECISION_STEP = 100;
const STEP_SAMPLES = 8;
/**
 * Attack size as a share of the attacker's troops. Tuned: large enough that tiles
 * actually change hands during the timed window, small enough that NO seat is
 * eliminated. Eliminations are not a cosmetic problem — they change the seat count
 * between the simulation samples and the observation arms, and then the aggregate
 * ratio divides quantities measured on different boards. The run asserts 16/16
 * alive at the end, so raising this until seats die fails loudly.
 */
const ATTACK_TROOP_FRACTION = 0.03;
/**
 * Hard ceiling on one attack, in troops. Without it an attack scales with the
 * attacker's income, so later samples launch bigger attacks than earlier ones, a
 * single execution chews through a neighbour for hundreds of ticks, and seats are
 * eliminated mid-run whatever `MIN_TARGET_TILES` says - the floor cannot retract an
 * attack that is already in flight. Tuned by measurement: 1,500 and 4,000 both hold
 * 16/16 seats with a steady 200 tiles of churn per window; 9,000 still holds but
 * churn turns lumpy (200-398); uncapped (~7,200 and rising) kills two seats by
 * sample 5.
 */
const ATTACK_TROOPS_CEILING = 4_000;

const SPATIAL_FLAG = "PROXYWAR_TUNE_SPATIAL_OBSERVATION";
const MINIMAP_FLAG = "PROXYWAR_TUNE_SPATIAL_MINIMAP";

function clearFlags(): void {
  delete process.env[SPATIAL_FLAG];
  delete process.env[MINIMAP_FLAG];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function landSeeds(game: Game, count: number): TileRef[] {
  const width = game.width();
  const height = game.height();
  // Seats must end up ADJACENT: a `TILES_PER_SEAT`-tile blob has radius
  // ~sqrt(tiles/pi), so separating seeds by much more than a diameter guarantees
  // no shared borders — which means no legal attacks, an inert engine, and a
  // meaningless tick measurement. Sized to leave a thin gap the growth closes.
  const blobRadius = Math.sqrt(TILES_PER_SEAT / Math.PI);
  const minSeparation = Math.max(8, Math.floor(blobRadius * 1.6));
  const seeds: { tile: TileRef; x: number; y: number }[] = [];
  const step = Math.max(2, Math.floor(Math.min(width, height) / 40));
  for (let y = step; y < height - step && seeds.length < count; y += step) {
    for (let x = step; x < width - step && seeds.length < count; x += step) {
      const tile = game.ref(x, y);
      if (!game.isLand(tile)) continue;
      if (
        seeds.some((seed) => Math.hypot(seed.x - x, seed.y - y) < minSeparation)
      ) {
        continue;
      }
      seeds.push({ tile, x, y });
    }
  }
  if (seeds.length < count) {
    throw new Error(
      `AgentDecisionPipelinePerf: only ${seeds.length} separated land seeds for ${count} seats`,
    );
  }
  return seeds.map((seed) => seed.tile);
}

const players = Array.from(
  { length: SEATS },
  (_, index) =>
    new PlayerInfo(
      `Seat ${index + 1}`,
      PlayerType.Human,
      `CLNT_${index + 1}`,
      `P_${index + 1}`,
    ),
);

clearFlags();
const game = await setup(
  "world",
  { nations: "disabled", instantBuild: true, infiniteGold: true },
  players,
  dirname(fileURLToPath(import.meta.url)),
);

const seeds = landSeeds(game, SEATS);
for (let index = 0; index < players.length; index++) {
  game.addExecution(new SpawnExecution("PERF", players[index], seeds[index]));
}
while (game.inSpawnPhase()) game.executeNextTick();

const seated: Player[] = players.map((info) => game.player(info.id));
const claimed = new Set<TileRef>();
const frontiers = seeds.map((seed) => [seed]);
const owned = seeds.map(() => 0);
for (let index = 0; index < seated.length; index++) {
  seated[index].conquer(seeds[index]);
  claimed.add(seeds[index]);
  owned[index] = 1;
}
let progressed = true;
while (progressed) {
  progressed = false;
  for (let index = 0; index < seated.length; index++) {
    if (owned[index] >= TILES_PER_SEAT) continue;
    const next: TileRef[] = [];
    for (const tile of frontiers[index]) {
      if (owned[index] >= TILES_PER_SEAT) break;
      for (const neighbor of game.neighbors(tile)) {
        if (owned[index] >= TILES_PER_SEAT) break;
        if (claimed.has(neighbor) || !game.isLand(neighbor)) continue;
        seated[index].conquer(neighbor);
        claimed.add(neighbor);
        owned[index] += 1;
        next.push(neighbor);
        progressed = true;
      }
    }
    frontiers[index] = next.length > 0 ? next : frontiers[index];
  }
}
/**
 * Structures, so the timed ticks execute unit logic too. Without them the board
 * has zero units and the tick time is a floor no live league game would hit.
 */
const STRUCTURES = [UnitType.City, UnitType.DefensePost, UnitType.MissileSilo];
for (const player of seated) {
  const tiles = [...player.tiles()];
  for (let index = 0; index < STRUCTURES.length; index++) {
    const tile = tiles[Math.floor(((index + 1) * tiles.length) / 5)];
    if (tile === undefined) continue;
    if (!player.canBuild(STRUCTURES[index], tile)) continue;
    player.buildUnit(STRUCTURES[index], tile, {});
  }
}
for (let tick = 0; tick < 10; tick++) game.executeNextTick();
if (game.units().length === 0) {
  throw new Error(
    "AgentDecisionPipelinePerf: no structures were built, so the timed ticks would " +
      "execute no unit logic. Refusing to report a tick time no live game could hit.",
  );
}

/**
 * Real attacks between neighbouring seats. Without this the engine has nothing
 * to execute and a "tick" measures an empty loop — the exact fault that
 * invalidated the first version of this harness.
 */
function armActivity(): number {
  let launched = 0;
  let bordering = 0;
  for (let index = 0; index < seated.length; index++) {
    const attacker = seated[index];
    if (!attacker.isAlive()) continue;
    const target = seated.find(
      (candidate) =>
        candidate !== attacker &&
        candidate.isAlive() &&
        attacker.sharesBorderWith(candidate),
    );
    if (target === undefined) continue;
    bordering += 1;
    const troops = Math.min(
      Number(attacker.troops()) * ATTACK_TROOP_FRACTION,
      ATTACK_TROOPS_CEILING,
    );
    if (!Number.isFinite(troops) || troops <= 1) continue;
    game.addExecution(new AttackExecution(troops, attacker, target.id()));
    launched += 1;
  }
  if (bordering === 0) {
    console.error(
      "warning: no seat shares a border yet — attacks cannot be launched",
    );
  }
  return launched;
}

const observationBuilder = new AgentObservationBuilder();
const legalActionBuilder = new LegalActionBuilder();
const promptBuilder = new LlmPromptBuilder();

function observeSeat(info: PlayerInfo) {
  return observationBuilder.build({
    agentID: `agent-${info.id}`,
    clientID: info.clientID,
    username: info.name,
    profile: "aggressive",
    gameID: "PERF",
    turnNumber: game.ticks(),
    gameState: game,
  });
}

// --- one decision step, measured END TO END on the SAME board state ----------
/**
 * Simulation and agent-side work are measured INSIDE the same sample, in the order
 * production runs them: `runDecisionTurn({gameState})` observes state A and submits
 * intents, and only then does the league advance A -> B
 * (`AgentStepLockedLeague.ts`). So each sample observes A, arms intents, then times
 * the 100 ticks that carry A -> B, and pairs those two numbers.
 *
 * Two earlier versions got this wrong. The first timed every tick up front and
 * every observation afterwards, dividing a final-state observation by simulation
 * windows from earlier, different states — and by then seats had died, so it
 * aggregated 14 survivors while calling it a 16-seat step. The second observed
 * AFTER the ticks, which is backwards and also cheaper: attacks launched at the
 * start of a window are largely resolved by its end, so the observation missed the
 * in-flight attacks production sees.
 */
type Arm = { key: string; flags: Record<string, string> };
const ARMS: Arm[] = [
  { key: "off", flags: {} },
  { key: "spatial", flags: { [SPATIAL_FLAG]: "1" } },
  { key: "minimap", flags: { [SPATIAL_FLAG]: "1", [MINIMAP_FLAG]: "1" } },
];

const simulationMs: number[] = [];
const armSamples: Record<
  string,
  { observation: number[]; menu: number[]; prompt: number[] }
> = Object.fromEntries(
  ARMS.map((arm) => [arm.key, { observation: [], menu: [], prompt: [] }]),
);
const seatsPerSample: number[] = [];

let totalLaunched = 0;
/**
 * Counting `addExecution` calls is NOT proof of work: a rejected execution is
 * added and then discarded (an early version of this harness passed a `Player`
 * where a `PlayerID` was wanted, and every attack was silently dropped).
 *
 * TILE churn is the load-bearing assertion. Troop churn is deliberately kept as a
 * second condition, but do not reduce the guard to it: measured with activity
 * disabled, troop churn was still ~6.9M because income accrues every tick on an
 * idle board, while tile churn was exactly 0. Only tile churn distinguishes war
 * from an empty loop.
 */
/**
 * Prime one window of activity so the very first observed state already has
 * attacks in flight, which is what production observes: leftovers from the
 * previous step's intents, since a 100-tick window rarely finishes an attack.
 *
 * The prime runs BEFORE the baselines below are captured. If it did not, its churn
 * would land in the totals and could make the workload guard pass even when every
 * timed sample was inert - the exact regression the guard exists to catch.
 */
armActivity();
for (let tick = 0; tick < TURNS_PER_DECISION_STEP; tick++) {
  game.executeNextTick();
}

const tilesBefore = seated.map((player) => player.numTilesOwned());
const troopsBefore = seated.map((player) => Number(player.troops()));
/** Tile churn inside each timed window, so one busy sample cannot mask the rest. */
const tileChurnPerSample: number[] = [];

/**
 * Load is sampled immediately BEFORE and AFTER the timed loop. An earlier version
 * read "before" after every sample had already run, so the printed pair described
 * nothing. `loadavg` is a 1-minute average, so the after-reading is the one that
 * reflects the measurement window; both are printed and the idle claim is gated on
 * the worse of the two.
 */
const cpuCount = os.availableParallelism();
const loadBeforeSamples = os.loadavg()[0] / Math.max(cpuCount, 1);

for (let sample = 0; sample < STEP_SAMPLES; sample++) {
  const living = players.filter((info) => game.player(info.id).isAlive());
  seatsPerSample.push(living.length);

  /**
   * Rotate the arm order every sample. With a fixed off -> spatial -> minimap
   * order, whichever arm runs first pays the JIT and cache warmup for the others,
   * which is indistinguishable from a feature being cheap.
   */
  const armOrder = ARMS.map((_, index) => ARMS[(index + sample) % ARMS.length]);
  for (const arm of armOrder) {
    clearFlags();
    for (const [key, value] of Object.entries(arm.flags)) {
      process.env[key] = value;
    }
    let observationMs = 0;
    let menuMs = 0;
    let promptMs = 0;
    /**
     * Production wraps the WHOLE roster in one `withObservationBatch`
     * (`AgentLeagueMatch.ts`), which builds the spatial/minimap snapshot and the
     * neutral-island transport scan once per synchronous batch and shares them
     * across seats. Calling `build()` per seat outside a batch leaves
     * `spatialObservationBatchCache` null and rebuilds that geometry 16 times,
     * which inflates the spatial and minimap ratios by most of a shared cost the
     * league never pays. Measure the pipeline the league actually runs.
     */
    observationBuilder.withObservationBatch(game, () => {
      for (const info of living) {
        let mark = performance.now();
        const observation = observeSeat(info);
        observationMs += performance.now() - mark;

        mark = performance.now();
        const legalActions = legalActionBuilder.build({ observation });
        menuMs += performance.now() - mark;

        mark = performance.now();
        promptBuilder.build({ observation, legalActions });
        promptMs += performance.now() - mark;
      }
      return undefined;
    });
    armSamples[arm.key].observation.push(observationMs);
    armSamples[arm.key].menu.push(menuMs);
    armSamples[arm.key].prompt.push(promptMs);
    clearFlags();
  }

  // Intents submitted, exactly as `runDecisionTurn` does before the league
  // advances the turns; then time the window those intents run in.
  totalLaunched += armActivity();
  const tilesAtWindowStart = seated.map((player) => player.numTilesOwned());
  const started = performance.now();
  for (let tick = 0; tick < TURNS_PER_DECISION_STEP; tick++) {
    game.executeNextTick();
  }
  simulationMs.push(performance.now() - started);
  tileChurnPerSample.push(
    seated.reduce(
      (sum, player, index) =>
        sum + Math.abs(player.numTilesOwned() - tilesAtWindowStart[index]),
      0,
    ),
  );
}

/**
 * NAMING, deliberately pedantic. This is the sum of |ownership-count change| over
 * seats. It counts a single tile transfer on BOTH sides, and it sees only NET change
 * per seat, so it is NOT a count of tiles that changed hands. It is used purely as a
 * nonzero liveness signal, and the printed label says exactly that.
 */
const loadAfterSamples = os.loadavg()[0] / Math.max(cpuCount, 1);
const IDLE_CEILING = 0.5;
const wasIdle = Math.max(loadBeforeSamples, loadAfterSamples) <= IDLE_CEILING;

const ownershipDelta = seated.reduce(
  (sum, player, index) =>
    sum + Math.abs(player.numTilesOwned() - tilesBefore[index]),
  0,
);
/**
 * Sum of |troop-total change|. Dominated by per-tick income accrual, not by
 * fighting: with activity fully disabled this still measured ~6.9M. It is NOT a
 * measure of troops moved and is not load-bearing for the guard.
 */
const troopDelta = seated.reduce(
  (sum, player, index) =>
    sum + Math.abs(Number(player.troops()) - troopsBefore[index]),
  0,
);
const inertSamples = tileChurnPerSample.filter((churn) => churn === 0).length;
if (
  totalLaunched === 0 ||
  ownershipDelta === 0 ||
  troopDelta === 0 ||
  inertSamples > 0
) {
  throw new Error(
    `AgentDecisionPipelinePerf: the timed windows did not all do real work ` +
      `(attacks launched ${totalLaunched}, aggregate ownership-count delta ${ownershipDelta}, ` +
      `aggregate troop-total delta ${troopDelta.toFixed(0)}, per-sample ownership delta ` +
      `[${tileChurnPerSample.join(",")}], ${inertSamples} inert sample(s)). ` +
      `Refusing to report a flattering tick time.`,
  );
}
const aliveSeats = seated.filter((player) => player.isAlive()).length;
const unitCount = game.units().length;
if (new Set(seatsPerSample).size !== 1 || seatsPerSample[0] !== SEATS) {
  throw new Error(
    `AgentDecisionPipelinePerf: seat count was not constant at ${SEATS} across samples ` +
      `(${seatsPerSample.join(",")}). A seat was eliminated mid-run, so the aggregate would ` +
      `mix different boards. Lower ATTACK_TROOPS_CEILING or raise MIN_TARGET_TILES.`,
  );
}

const off = {
  observation: median(armSamples.off.observation),
  menu: median(armSamples.off.menu),
  prompt: median(armSamples.off.prompt),
};

/**
 * Every ratio is PAIRED within a sample: same board state, same warmup, same host
 * conditions. Dividing one arm's median by another's would mix samples and let a
 * transient stall in either arm masquerade as a feature cost.
 */
const perSampleRatios = simulationMs.map((simulation, index) => {
  const agentSide =
    armSamples.off.observation[index] +
    armSamples.off.menu[index] +
    armSamples.off.prompt[index];
  return agentSide / Math.max(simulation, 1e-9);
});
const pairedRatios = (armKey: string): number[] =>
  armSamples[armKey].observation.map(
    (observation, index) =>
      observation / Math.max(armSamples.off.observation[index], 1e-9),
  );
const spatialRatios = pairedRatios("spatial");
const minimapRatios = pairedRatios("minimap");
const summarize = (values: readonly number[]) =>
  `${median(values).toFixed(2)}x (range ${Math.min(...values).toFixed(2)}x-${Math.max(...values).toFixed(2)}x)`;

const simulationPerStep = median(simulationMs);
const agentSidePerStep = off.observation + off.menu + off.prompt;
const total = simulationPerStep + agentSidePerStep;
const pct = (ms: number) => `${((100 * ms) / total).toFixed(1)}%`;

const seatSizes = seated.map((player) => player.numTilesOwned());
console.log(
  `Board: ${aliveSeats}/${SEATS} seats alive for every sample. Tiles per seat: ` +
    `min ${Math.min(...seatSizes)}, median ${median(seatSizes)}, max ${Math.max(...seatSizes)} ` +
    `(TILES_PER_SEAT=${TILES_PER_SEAT} is a growth CAP, not a guarantee - cramped regions of ` +
    `\`world\` leave some seats short). ${unitCount} units (cities/defense posts/silos).`,
);
console.log(
  `Liveness: ${totalLaunched} attacks launched; aggregate ownership-count delta ` +
    `${ownershipDelta} (per sample ${tileChurnPerSample.join(",")}, all nonzero). Each transfer is ` +
    `counted on both sides and only net change is visible, so this is a liveness signal, not a ` +
    `count of tiles that changed hands. Aggregate troop-total delta ${troopDelta.toFixed(0)} is ` +
    `mostly income accrual and proves nothing on its own.`,
);
console.log("");
console.log(
  `One decision step = ${TURNS_PER_DECISION_STEP} ticks + one observation/menu/prompt for each of ${SEATS} seats,`,
);
console.log(
  `measured inside the same sample (median of ${STEP_SAMPLES} samples):`,
);
console.log(
  `  simulation   ${simulationPerStep.toFixed(1)} ms  ${pct(simulationPerStep)}`,
);
console.log(
  `  observation  ${off.observation.toFixed(1)} ms  ${pct(off.observation)}   (${SEATS} seats; ${(off.observation / SEATS).toFixed(1)} ms per seat)`,
);
console.log(
  `  menu         ${off.menu.toFixed(1)} ms  ${pct(off.menu)}   prompt ${off.prompt.toFixed(1)} ms  ${pct(off.prompt)}`,
);
console.log(
  `  agent-side   ${agentSidePerStep.toFixed(1)} ms  ${pct(agentSidePerStep)} of the step`,
);
console.log("");
console.log("Ratios (load-robust; each ratio from one sample's own state):");
console.log(
  `  agent-side / simulation        : ${median(perSampleRatios).toFixed(0)}x per ${SEATS}-seat step ` +
    `(range ${Math.min(...perSampleRatios).toFixed(0)}x-${Math.max(...perSampleRatios).toFixed(0)}x), ` +
    `${(median(perSampleRatios) / SEATS).toFixed(1)}x per seat`,
);
console.log(
  `  spatial ON / flags off         : ${summarize(spatialRatios)} observation`,
);
console.log(
  `  spatial + minimap / flags off  : ${summarize(minimapRatios)} observation`,
);
console.log("");
console.log(
  `Host: ${cpuCount} cpus, normalized 1m load ${loadBeforeSamples.toFixed(2)} before the timed loop ` +
    `-> ${loadAfterSamples.toFixed(2)} after it.`,
);
console.log(
  wasIdle
    ? `Host was idle by the <=${IDLE_CEILING} normalized-load bar: absolute ms above are usable.`
    : `HOST WAS NOT IDLE (>${IDLE_CEILING} normalized load): treat every absolute ms above as ` +
        `PROVISIONAL and rerun on an idle host before quoting them. The paired ratios are ` +
        `load-robust and still stand.`,
);
