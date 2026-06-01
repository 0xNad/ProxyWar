import fs from "fs/promises";
import path from "path";
import type {
  HumanReplayPlayer,
  HumanReplayRecord,
  StatArray,
  StatValue,
} from "./HumanReplayAnalysis";

export const humanReplayNuclearUnits = [
  "Missile Silo",
  "SAM Launcher",
  "Atom Bomb",
  "Hydrogen Bomb",
  "MIRV",
] as const;

export type HumanReplayNuclearUnit = (typeof humanReplayNuclearUnits)[number];

export interface HumanReplayNuclearEvent {
  gameID: string;
  clientID: string;
  username: string;
  winner: boolean;
  unit: HumanReplayNuclearUnit;
  turnNumber: number;
  minute: number;
  tile: number | null;
}

export interface HumanReplayNuclearPlayerSummary {
  gameID: string;
  clientID: string;
  username: string;
  winner: boolean;
  firstSiloMinute: number | null;
  firstSamMinute: number | null;
  firstNukeMinute: number | null;
  firstHydrogenMinute: number | null;
  firstMirvMinute: number | null;
  silosBuilt: number;
  samLaunchersBuilt: number;
  atomBombsLaunched: number;
  hydrogenBombsLaunched: number;
  mirvsLaunched: number;
  cityCount: number;
  factoryCount: number;
  portCount: number;
  totalGold: number;
}

export interface HumanReplayNuclearUnitSummary {
  count: number;
  winnerCount: number;
  firstMinuteP25: number | null;
  firstMinuteP50: number | null;
  firstMinuteP75: number | null;
  winnerFirstMinuteP50: number | null;
}

export interface HumanReplayNuclearReport {
  schemaVersion: 1;
  generatedAt: string;
  source: string;
  gameCount: number;
  playerCount: number;
  nuclearEventCount: number;
  units: Record<HumanReplayNuclearUnit, HumanReplayNuclearUnitSummary>;
  winners: {
    count: number;
    withSiloShare: number;
    withSamShare: number;
    withNukeShare: number;
    medianFirstSiloMinute: number | null;
    medianFirstSamMinute: number | null;
    medianFirstNukeMinute: number | null;
    averageSilosBuilt: number;
    averageSamLaunchersBuilt: number;
    averageAtomBombsLaunched: number;
    averageHydrogenBombsLaunched: number;
    averageMirvsLaunched: number;
  };
  insights: string[];
  agentRecommendations: string[];
  sampleEvents: HumanReplayNuclearEvent[];
}

export interface HumanReplayNuclearReportInput {
  records: HumanReplayRecord[];
  source?: string;
  generatedAt?: number;
}

export interface HumanReplayNuclearArtifactPaths {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export function buildHumanReplayNuclearReport(
  input: HumanReplayNuclearReportInput,
): HumanReplayNuclearReport {
  const generatedAt = input.generatedAt ?? Date.now();
  const events: HumanReplayNuclearEvent[] = [];
  const players: HumanReplayNuclearPlayerSummary[] = [];

  for (const record of input.records) {
    const turnsPerMinute = inferTurnsPerMinute(record);
    const winnerClientID = record.info.winner?.[1] ?? null;
    const playerByID = new Map(
      record.info.players.map((player) => [player.clientID, player]),
    );
    const playerEvents = new Map<string, HumanReplayNuclearEvent[]>();
    for (const turn of record.turns ?? []) {
      for (const intent of turn.intents ?? []) {
        const unit = nuclearUnit(intent.unit);
        if (
          intent.type !== "build_unit" ||
          intent.clientID === undefined ||
          unit === null
        ) {
          continue;
        }
        const player = playerByID.get(intent.clientID);
        const event: HumanReplayNuclearEvent = {
          gameID: record.info.gameID,
          clientID: intent.clientID,
          username: player?.username ?? intent.clientID,
          winner: intent.clientID === winnerClientID,
          unit,
          turnNumber: turn.turnNumber,
          minute: round2(turn.turnNumber / turnsPerMinute),
          tile: typeof intent.tile === "number" ? intent.tile : null,
        };
        events.push(event);
        const list = playerEvents.get(intent.clientID) ?? [];
        list.push(event);
        playerEvents.set(intent.clientID, list);
      }
    }
    for (const player of record.info.players) {
      players.push(
        summarizeNuclearPlayer(
          record.info.gameID,
          player,
          player.clientID === winnerClientID,
          playerEvents.get(player.clientID) ?? [],
        ),
      );
    }
  }

  const winners = players.filter((player) => player.winner);
  const units = Object.fromEntries(
    humanReplayNuclearUnits.map((unit) => {
      const unitEvents = events.filter((event) => event.unit === unit);
      const firstByPlayer = firstEventMinuteByPlayer(unitEvents);
      const winnerFirstByPlayer = firstEventMinuteByPlayer(
        unitEvents.filter((event) => event.winner),
      );
      return [
        unit,
        {
          count: unitEvents.length,
          winnerCount: unitEvents.filter((event) => event.winner).length,
          firstMinuteP25: percentile(Array.from(firstByPlayer.values()), 0.25),
          firstMinuteP50: percentile(Array.from(firstByPlayer.values()), 0.5),
          firstMinuteP75: percentile(Array.from(firstByPlayer.values()), 0.75),
          winnerFirstMinuteP50: percentile(
            Array.from(winnerFirstByPlayer.values()),
            0.5,
          ),
        },
      ];
    }),
  ) as Record<HumanReplayNuclearUnit, HumanReplayNuclearUnitSummary>;

  const report: HumanReplayNuclearReport = {
    schemaVersion: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    source: input.source ?? "local human replay records",
    gameCount: input.records.length,
    playerCount: players.length,
    nuclearEventCount: events.length,
    units,
    winners: {
      count: winners.length,
      withSiloShare: ratio(
        winners.filter((player) => player.silosBuilt > 0).length,
        winners.length,
      ),
      withSamShare: ratio(
        winners.filter((player) => player.samLaunchersBuilt > 0).length,
        winners.length,
      ),
      withNukeShare: ratio(
        winners.filter(
          (player) =>
            player.atomBombsLaunched +
              player.hydrogenBombsLaunched +
              player.mirvsLaunched >
            0,
        ).length,
        winners.length,
      ),
      medianFirstSiloMinute: percentile(
        winners.map((player) => player.firstSiloMinute),
        0.5,
      ),
      medianFirstSamMinute: percentile(
        winners.map((player) => player.firstSamMinute),
        0.5,
      ),
      medianFirstNukeMinute: percentile(
        winners.map((player) => player.firstNukeMinute),
        0.5,
      ),
      averageSilosBuilt: average(winners.map((player) => player.silosBuilt)),
      averageSamLaunchersBuilt: average(
        winners.map((player) => player.samLaunchersBuilt),
      ),
      averageAtomBombsLaunched: average(
        winners.map((player) => player.atomBombsLaunched),
      ),
      averageHydrogenBombsLaunched: average(
        winners.map((player) => player.hydrogenBombsLaunched),
      ),
      averageMirvsLaunched: average(
        winners.map((player) => player.mirvsLaunched),
      ),
    },
    insights: [],
    agentRecommendations: [],
    sampleEvents: events.slice(0, 25),
  };
  report.insights = nuclearInsights(report);
  report.agentRecommendations = nuclearRecommendations(report);
  return report;
}

export async function writeHumanReplayNuclearArtifacts(input: {
  records: HumanReplayRecord[];
  directory: string;
  source?: string;
  generatedAt?: number;
}): Promise<HumanReplayNuclearArtifactPaths> {
  const report = buildHumanReplayNuclearReport(input);
  await fs.mkdir(input.directory, { recursive: true });
  const jsonPath = path.join(input.directory, "human-nuclear-report.json");
  const markdownPath = path.join(input.directory, "human-nuclear-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(markdownPath, renderHumanReplayNuclearMarkdown(report));
  return { directory: input.directory, jsonPath, markdownPath };
}

export function renderHumanReplayNuclearMarkdown(
  report: HumanReplayNuclearReport,
): string {
  const unitRows = humanReplayNuclearUnits
    .map((unit) => {
      const summary = report.units[unit];
      return `| ${unit} | ${summary.count} | ${summary.firstMinuteP50 ?? "n/a"} | ${summary.winnerFirstMinuteP50 ?? "n/a"} |`;
    })
    .join("\n");
  return [
    `# Human Nuclear Replay Report`,
    "",
    `- Generated: ${report.generatedAt}`,
    `- Source: ${report.source}`,
    `- Games: ${report.gameCount}`,
    `- Players: ${report.playerCount}`,
    `- Nuclear events: ${report.nuclearEventCount}`,
    "",
    "## Unit Timing",
    "",
    "| Unit | Events | Median first minute | Winner median first minute |",
    "| --- | ---: | ---: | ---: |",
    unitRows,
    "",
    "## Winner Profile",
    "",
    `- Winners with silos: ${report.winners.withSiloShare}`,
    `- Winners with SAMs: ${report.winners.withSamShare}`,
    `- Winners with nuclear launches: ${report.winners.withNukeShare}`,
    `- Average winner silos/SAMs/atom/hydrogen/MIRV: ${report.winners.averageSilosBuilt}/${report.winners.averageSamLaunchersBuilt}/${report.winners.averageAtomBombsLaunched}/${report.winners.averageHydrogenBombsLaunched}/${report.winners.averageMirvsLaunched}`,
    "",
    "## Insights",
    "",
    ...report.insights.map((insight) => `- ${insight}`),
    "",
    "## Agent Recommendations",
    "",
    ...report.agentRecommendations.map(
      (recommendation) => `- ${recommendation}`,
    ),
    "",
  ].join("\n");
}

function summarizeNuclearPlayer(
  gameID: string,
  player: HumanReplayPlayer,
  winner: boolean,
  events: HumanReplayNuclearEvent[],
): HumanReplayNuclearPlayerSummary {
  const units = player.stats?.units ?? {};
  const bombs = player.stats?.bombs ?? {};
  return {
    gameID,
    clientID: player.clientID,
    username: player.username,
    winner,
    firstSiloMinute: firstUnitMinute(events, "Missile Silo"),
    firstSamMinute: firstUnitMinute(events, "SAM Launcher"),
    firstNukeMinute: firstUnitMinute(events, [
      "Atom Bomb",
      "Hydrogen Bomb",
      "MIRV",
    ]),
    firstHydrogenMinute: firstUnitMinute(events, "Hydrogen Bomb"),
    firstMirvMinute: firstUnitMinute(events, "MIRV"),
    silosBuilt: statNumber(units.silo?.[0]),
    samLaunchersBuilt: statNumber(units.saml?.[0]),
    atomBombsLaunched: statNumber(bombs.abomb?.[0]),
    hydrogenBombsLaunched: statNumber(bombs.hbomb?.[0]),
    mirvsLaunched: statNumber(bombs.mirv?.[0]),
    cityCount: statNumber(units.city?.[0]),
    factoryCount: statNumber(units.fact?.[0]),
    portCount: statNumber(units.port?.[0]),
    totalGold: sumStatArray(player.stats?.gold),
  };
}

function nuclearInsights(report: HumanReplayNuclearReport): string[] {
  return [
    `Nuclear play is common in the mined corpus: ${report.nuclearEventCount} silo/SAM/nuke events across ${report.gameCount} games.`,
    `Winner median first silo/SAM/nuke minutes were ${report.winners.medianFirstSiloMinute ?? "n/a"}/${report.winners.medianFirstSamMinute ?? "n/a"}/${report.winners.medianFirstNukeMinute ?? "n/a"}.`,
    `Winners averaged ${report.winners.averageSilosBuilt} silos and ${report.winners.averageSamLaunchersBuilt} SAM launchers, so deterrence is an economy phase, not only a final panic button.`,
    `Hydrogen bombs and MIRVs appear later than first silos; the agent should build the delivery and air-defense layer before trying to spam expensive weapons.`,
  ];
}

function nuclearRecommendations(report: HumanReplayNuclearReport): string[] {
  return [
    `After a basic City/Factory/Port foundation, build the first missile silo around the replay median window instead of waiting for dominant land share.`,
    `Build the first SAM when valuable economy or a silo exists; protect the deterrent before the first serious nuclear exchange.`,
    `When launching, prefer leader/incoming-attacker targets and high-value structures in this order: missile silo, SAM launcher, city, factory, port, defense post.`,
    `If a target has SAM coverage, strike SAMs or silos first when legal; avoid spending a nuke on low-value covered land.`,
    `Use nuclear quick-chat threats only when a larger rival is reachable and deterrence is credible; it should support diplomacy, not replace land pressure.`,
  ];
}

function firstUnitMinute(
  events: HumanReplayNuclearEvent[],
  units: HumanReplayNuclearUnit | HumanReplayNuclearUnit[],
): number | null {
  const accepted = new Set(Array.isArray(units) ? units : [units]);
  const match = events
    .filter((event) => accepted.has(event.unit))
    .sort((a, b) => a.minute - b.minute)[0];
  return match?.minute ?? null;
}

function firstEventMinuteByPlayer(
  events: HumanReplayNuclearEvent[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const event of events) {
    const key = `${event.gameID}:${event.clientID}`;
    const current = result.get(key);
    if (current === undefined || event.minute < current) {
      result.set(key, event.minute);
    }
  }
  return result;
}

function nuclearUnit(value: unknown): HumanReplayNuclearUnit | null {
  return humanReplayNuclearUnits.find((unit) => unit === value) ?? null;
}

function inferTurnsPerMinute(record: HumanReplayRecord): number {
  const duration = record.info.duration;
  const turnCount = record.info.num_turns;
  if (
    typeof duration === "number" &&
    duration > 0 &&
    typeof turnCount === "number" &&
    turnCount > 0
  ) {
    return turnCount / (duration / 60);
  }
  return 600;
}

function percentile(
  values: Array<number | null | undefined>,
  q: number,
): number | null {
  const finite = values
    .filter((value): value is number => typeof value === "number")
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (finite.length === 0) {
    return null;
  }
  const index = Math.min(
    finite.length - 1,
    Math.max(0, Math.floor((finite.length - 1) * q)),
  );
  return round2(finite[index]);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function ratio(value: number, total: number): number {
  return total <= 0 ? 0 : round2(value / total);
}

function sumStatArray(values: StatArray | undefined): number {
  return (values ?? []).reduce<number>(
    (sum, value) => sum + statNumber(value),
    0,
  );
}

function statNumber(value: StatValue): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
