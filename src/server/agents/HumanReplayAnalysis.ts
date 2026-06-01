import fs from "fs/promises";
import path from "path";

export interface HumanReplayStats {
  attacks?: StatArray;
  betrayals?: StatValue;
  killedAt?: StatValue;
  conquests?: StatArray;
  boats?: Record<string, StatArray | undefined>;
  bombs?: Record<string, StatArray | undefined>;
  gold?: StatArray;
  units?: Record<string, StatArray | undefined>;
}

export interface HumanReplayPlayer {
  clientID: string;
  username: string;
  clanTag?: string | null;
  stats?: HumanReplayStats | null;
}

export interface HumanReplayTurn {
  turnNumber: number;
  intents?: HumanReplayIntent[];
}

export interface HumanReplayIntent {
  type: string;
  clientID?: string;
  targetID?: string | null;
  troops?: number | string | null;
  unit?: string | null;
  tile?: number | null;
  rocketDirectionUp?: boolean | null;
}

export interface HumanReplayRecord {
  version?: string;
  gitCommit?: string | null;
  domain?: string;
  subdomain?: string;
  info: {
    gameID: string;
    config?: Record<string, unknown>;
    players: HumanReplayPlayer[];
    winner?: [string, string] | null;
    duration?: number | null;
    num_turns?: number | null;
    start?: number | string | null;
    end?: number | string | null;
  };
  turns?: HumanReplayTurn[];
}

export interface HumanReplayAnalysisInput {
  record: HumanReplayRecord;
  source?: string | null;
  generatedAt?: number;
  topCandidateCount?: number;
}

export interface HumanReplayAnalysisPaths {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export interface HumanReplayCorpusPaths {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export interface HumanReplayAnalysisReport {
  schemaVersion: 1;
  gameID: string;
  generatedAt: string;
  source: string | null;
  replay: {
    version: string | null;
    gitCommit: string | null;
    domain: string | null;
    subdomain: string | null;
    durationSeconds: number | null;
    turnCount: number | null;
    archivedTurnCount: number;
    turnsPerMinute: number;
    config: Record<string, unknown>;
    exactFinalLeaderboardAvailable: false;
    exactFinalLeaderboardNote: string;
  };
  winner: HumanReplayPlayerSummary | null;
  topCandidates: HumanReplayPlayerSummary[];
  phaseDefinitions: HumanReplayPhaseDefinition[];
  tacticSignals: HumanReplayTacticSignal[];
  humanBaselines: HumanReplayHumanBaselines;
  skillGuidelineCandidates: HumanReplaySkillGuidelineCandidate[];
  llmReviewPacket: HumanReplayLlmReviewPacket;
}

export interface HumanReplayCorpusInput {
  corpusID: string;
  source: string;
  analyses: HumanReplayAnalysisReport[];
  discoveredGames?: HumanReplayGameMetadata[];
  generatedAt?: number;
}

export interface HumanReplayGameMetadata {
  game: string;
  start?: string;
  end?: string;
  type?: string;
  mode?: string;
  difficulty?: string;
  numPlayers?: number;
  maxPlayers?: number;
  rankedType?: string | null;
}

export interface HumanReplayCorpusReport {
  schemaVersion: 1;
  corpusID: string;
  generatedAt: string;
  source: string;
  gameCount: number;
  replayLinks: HumanReplayLink[];
  linkGeneration: {
    format: string;
    gameIDSource: string;
    workerPathRule: string;
    gameIDRule: string;
  };
  aggregateBaselines: HumanReplayHumanBaselines;
  winnerBaselines: HumanReplayHumanBaselines;
  tacticFrequencies: Record<string, number>;
  winnerTacticFrequencies: Record<string, number>;
  topPlayers: HumanReplayCorpusPlayerSummary[];
  winnerPlayers: HumanReplayCorpusPlayerSummary[];
  insights: string[];
  agentBehaviorRecommendations: HumanReplaySkillGuidelineCandidate[];
  llmReviewPacket: {
    role: "human_replay_corpus_researcher";
    constraints: string[];
    focusQuestions: string[];
    requestedOutput: string[];
  };
}

export interface HumanReplayLink {
  gameID: string;
  replayUrl: string;
  workerPath: string;
  winner: string | null;
  config: string;
}

export interface HumanReplayCorpusPlayerSummary {
  gameID: string;
  replayUrl: string;
  rank: number;
  username: string;
  clientID: string;
  winner: boolean;
  compositeScore: number;
  firstAttackMinute: number | null;
  firstBoatMinute: number | null;
  openingAttackCount: number;
  transportsSent: number;
  tradeShipsSent: number;
  tradeGold: number;
  targetedAttackTroops: number;
  capturedCities: number;
  capturedFactories: number;
  capturedPorts: number;
  tacticTags: string[];
}

export interface HumanReplayPlayerSummary {
  rank: number;
  username: string;
  clientID: string;
  clanTag: string | null;
  winner: boolean;
  survivedToEnd: boolean;
  killedAtTurn: number | null;
  compositeScore: number;
  scoreBreakdown: {
    outcome: number;
    survival: number;
    expansion: number;
    economy: number;
    naval: number;
    pressure: number;
    endgame: number;
  };
  stats: HumanReplayPlayerStatsSummary;
  actionProfile: HumanReplayActionProfile;
  tacticTags: string[];
}

export interface HumanReplayPlayerStatsSummary {
  attacksSent: number;
  attacksReceived: number;
  attacksCancelled: number;
  conquests: number;
  betrayals: number;
  transportsSent: number;
  transportsArrived: number;
  transportsCaptured: number;
  transportsDestroyed: number;
  tradeShipsSent: number;
  tradeShipsArrived: number;
  tradeShipsCaptured: number;
  tradeShipsDestroyed: number;
  workerGold: number;
  warGold: number;
  tradeGold: number;
  stolenTradeGold: number;
  trainSelfGold: number;
  trainOtherGold: number;
  totalGold: number;
  bombsLaunched: number;
  bombsLanded: number;
  bombsIntercepted: number;
  atomBombsLaunched: number;
  hydrogenBombsLaunched: number;
  mirvsLaunched: number;
  mirvWarheadsLaunched: number;
  citiesBuilt: number;
  citiesCaptured: number;
  factoriesBuilt: number;
  factoriesCaptured: number;
  portsBuilt: number;
  portsCaptured: number;
  defensePostsBuilt: number;
  warshipsBuilt: number;
  silosBuilt: number;
  samLaunchersBuilt: number;
  totalStructuresBuilt: number;
  totalStructuresCaptured: number;
  totalStructuresLost: number;
}

export interface HumanReplayActionProfile {
  firstActionTurn: Partial<Record<string, number>>;
  firstActionMinute: Partial<Record<string, number>>;
  actionCounts: Record<string, number>;
  phaseCounts: Record<string, Record<string, number>>;
  buildCounts: Record<string, number>;
  troopSums: {
    boatTroops: number;
    attackTroops: number;
    neutralAttackTroops: number;
    targetedAttackTroops: number;
  };
}

export interface HumanReplayPhaseDefinition {
  id: string;
  label: string;
  startMinute: number;
  endMinute: number | null;
}

export interface HumanReplayTacticSignal {
  tacticID: string;
  label: string;
  summary: string;
  evidence: string[];
  examplePlayers: string[];
}

export interface HumanReplayHumanBaselines {
  topPlayerCount: number;
  medianFirstAttackMinute: number | null;
  medianFirstBoatMinute: number | null;
  medianFirstBuildMinute: number | null;
  medianOpeningAttackCount: number | null;
  medianOpeningBoatCount: number | null;
  medianTransportSent: number | null;
  medianTradeShipsSent: number | null;
  medianTradeGold: number | null;
  medianTargetedAttackTroops: number | null;
  medianCapturedCities: number | null;
  medianCapturedFactories: number | null;
  medianCapturedPorts: number | null;
}

export interface HumanReplaySkillGuidelineCandidate {
  tacticID: string;
  title: string;
  evidence: string;
  guideline: string;
}

export interface HumanReplayLlmReviewPacket {
  role: "human_replay_tactic_researcher";
  constraints: string[];
  topCandidateClientIDs: string[];
  focusQuestions: string[];
  requestedOutput: string[];
}

export type StatArray = Array<string | number | bigint | null | undefined>;
export type StatValue = string | number | bigint | null | undefined;

interface PlayerAccumulator {
  player: HumanReplayPlayer;
  winner: boolean;
  stats: HumanReplayPlayerStatsSummary;
  actionProfile: HumanReplayActionProfile;
}

const DEFAULT_PHASES: HumanReplayPhaseDefinition[] = [
  { id: "opening", label: "0-5m", startMinute: 0, endMinute: 5 },
  { id: "growth", label: "5-15m", startMinute: 5, endMinute: 15 },
  { id: "midgame", label: "15-25m", startMinute: 15, endMinute: 25 },
  { id: "endgame", label: "25m+", startMinute: 25, endMinute: null },
];

const EXACT_LEADERBOARD_NOTE =
  "The public replay record exposes winner, per-player stats, and archived actions, but not a final territory leaderboard. Exact final placement requires replay-state reconstruction with the original game build.";

export function buildHumanReplayAnalysis(
  input: HumanReplayAnalysisInput,
): HumanReplayAnalysisReport {
  const record = input.record;
  const turns = record.turns ?? [];
  const turnsPerMinute = inferTurnsPerMinute(record);
  const winnerClientID = record.info.winner?.[1] ?? null;
  const players = record.info.players;
  const accumulators = new Map<string, PlayerAccumulator>();

  for (const player of players) {
    const stats = summarizeStats(player.stats ?? null);
    accumulators.set(player.clientID, {
      player,
      winner: player.clientID === winnerClientID,
      stats,
      actionProfile: emptyActionProfile(),
    });
  }

  for (const turn of turns) {
    for (const intent of turn.intents ?? []) {
      if (intent.clientID === undefined) {
        continue;
      }
      const accumulator = accumulators.get(intent.clientID);
      if (accumulator === undefined) {
        continue;
      }
      recordIntent(
        accumulator.actionProfile,
        intent,
        turn.turnNumber,
        turnsPerMinute,
      );
    }
  }

  const ranked = Array.from(accumulators.values())
    .filter(hasMeaningfulPlay)
    .map((accumulator) => summarizePlayer(accumulator))
    .sort(comparePlayerSummaries)
    .map((summary, index) => ({ ...summary, rank: index + 1 }));
  const topCandidates = ranked.slice(0, input.topCandidateCount ?? 5);
  const winner =
    ranked.find((summary) => summary.clientID === winnerClientID) ?? null;
  const humanBaselines = buildHumanBaselines(topCandidates);
  const tacticSignals = buildTacticSignals(topCandidates, humanBaselines);
  const skillGuidelineCandidates = buildSkillGuidelineCandidates(
    topCandidates,
    humanBaselines,
  );

  return {
    schemaVersion: 1,
    gameID: record.info.gameID,
    generatedAt: new Date(input.generatedAt ?? Date.now()).toISOString(),
    source: input.source ?? null,
    replay: {
      version: record.version ?? null,
      gitCommit: record.gitCommit ?? null,
      domain: record.domain ?? null,
      subdomain: record.subdomain ?? null,
      durationSeconds: record.info.duration ?? null,
      turnCount: record.info.num_turns ?? null,
      archivedTurnCount: turns.length,
      turnsPerMinute,
      config: record.info.config ?? {},
      exactFinalLeaderboardAvailable: false,
      exactFinalLeaderboardNote: EXACT_LEADERBOARD_NOTE,
    },
    winner,
    topCandidates,
    phaseDefinitions: DEFAULT_PHASES,
    tacticSignals,
    humanBaselines,
    skillGuidelineCandidates,
    llmReviewPacket: {
      role: "human_replay_tactic_researcher",
      constraints: [
        "Use human replay records as evidence, not as raw in-match commands.",
        "Any live-agent change must preserve LegalAction[] -> AgentDecision selecting an existing LegalAction.id.",
        "Do not propose a second runner, action schema, validator, or raw game intent path.",
        "Prefer planner guidance, scoring features, objective refresh rules, and post-match skill updates.",
      ],
      topCandidateClientIDs: topCandidates.map((player) => player.clientID),
      focusQuestions: [
        "Which human timing thresholds are missing from AgentObservation or planner briefs?",
        "Which tactic tags correlate with the strongest human candidates in this replay?",
        "Which one tactic can be converted into a small benchmarkable planner/executor experiment?",
      ],
      requestedOutput: [
        "Name one concrete agent skill or scoring change.",
        "Cite player names and timing evidence from the replay analysis.",
        "Name the benchmark command and success metric for the next A/B run.",
      ],
    },
  };
}

export function buildHumanReplayCorpusReport(
  input: HumanReplayCorpusInput,
): HumanReplayCorpusReport {
  const replayLinks = input.analyses.map((analysis) =>
    humanReplayLink(analysis),
  );
  const topPlayers = input.analyses.flatMap((analysis) =>
    analysis.topCandidates.map((player) =>
      corpusPlayerSummary(analysis.gameID, player),
    ),
  );
  const winnerPlayers = input.analyses.flatMap((analysis) =>
    analysis.winner === null
      ? []
      : [corpusPlayerSummary(analysis.gameID, analysis.winner)],
  );
  const aggregateBaselines = buildHumanBaselinesFromCorpus(topPlayers);
  const winnerBaselines = buildHumanBaselinesFromCorpus(winnerPlayers);
  const tacticFrequencies = tacticFrequenciesForPlayers(topPlayers);
  const winnerTacticFrequencies = tacticFrequenciesForPlayers(winnerPlayers);
  const recommendationBaselines =
    winnerPlayers.length > 0 ? winnerBaselines : aggregateBaselines;
  const recommendationFrequencies =
    winnerPlayers.length > 0 ? winnerTacticFrequencies : tacticFrequencies;
  const agentBehaviorRecommendations = corpusGuidelineCandidates(
    recommendationBaselines,
    recommendationFrequencies,
  );

  return {
    schemaVersion: 1,
    corpusID: input.corpusID,
    generatedAt: new Date(input.generatedAt ?? Date.now()).toISOString(),
    source: input.source,
    gameCount: input.analyses.length,
    replayLinks,
    linkGeneration: {
      format: "https://openfront.io/<workerPath>/game/<gameID>?replay",
      gameIDSource:
        "GET https://api.openfront.io/public/games returns the game field; GET /public/game/:gameId returns the archived replay record.",
      workerPathRule:
        "Production uses workerPath(gameID) = `w${simpleHash(gameID) % 20}`.",
      gameIDRule:
        "The client/server generate eight-character game IDs with nanoid using alphabet 123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ.",
    },
    aggregateBaselines,
    winnerBaselines,
    tacticFrequencies,
    winnerTacticFrequencies,
    topPlayers: topPlayers
      .sort(
        (a, b) =>
          Number(b.winner) - Number(a.winner) ||
          b.compositeScore - a.compositeScore,
      )
      .slice(0, 25),
    winnerPlayers: winnerPlayers
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, 50),
    insights: corpusInsights(
      aggregateBaselines,
      winnerBaselines,
      tacticFrequencies,
      winnerTacticFrequencies,
      topPlayers,
      winnerPlayers,
    ),
    agentBehaviorRecommendations,
    llmReviewPacket: {
      role: "human_replay_corpus_researcher",
      constraints: [
        "Use the human replay corpus as evidence for planner/executor changes.",
        "Any in-match change must still select existing LegalAction.id values.",
        "Do not add raw game intent generation, a second runner, or a second validator.",
        "Prefer behavior changes in canonical agent modules and skill guidance.",
      ],
      focusQuestions: [
        "Which aggregate human timing threshold should the planner brief expose?",
        "Which tactic gap is most likely responsible for weak opening or stalled midgame agents?",
        "Which single change should be benchmarked against hard nations next?",
      ],
      requestedOutput: [
        "Name the exact code behavior or skill rule to change.",
        "Cite aggregate human replay baselines as evidence.",
        "Define a measurable benchmark success metric.",
      ],
    },
  };
}

export async function writeHumanReplayCorpusArtifacts(input: {
  corpusID: string;
  source: string;
  analyses: HumanReplayAnalysisReport[];
  discoveredGames?: HumanReplayGameMetadata[];
  directory?: string;
  rootDir?: string;
  generatedAt?: number;
}): Promise<HumanReplayCorpusPaths> {
  const report = buildHumanReplayCorpusReport(input);
  const directory =
    input.directory ??
    path.join(
      input.rootDir ?? path.join(process.cwd(), "artifacts", "human-replays"),
      "batches",
      safePathSegment(report.corpusID),
    );
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, "human-replay-corpus.json");
  const markdownPath = path.join(directory, "human-replay-corpus.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, humanReplayCorpusMarkdown(report)),
  ]);
  return { directory, jsonPath, markdownPath };
}

export async function writeHumanReplayAnalysisArtifacts(input: {
  record: HumanReplayRecord;
  source?: string | null;
  directory?: string;
  rootDir?: string;
  generatedAt?: number;
  topCandidateCount?: number;
}): Promise<HumanReplayAnalysisPaths> {
  const report = buildHumanReplayAnalysis(input);
  const directory =
    input.directory ??
    path.join(
      input.rootDir ?? path.join(process.cwd(), "artifacts", "human-replays"),
      safePathSegment(report.gameID),
    );
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, "human-replay-analysis.json");
  const markdownPath = path.join(directory, "human-replay-analysis.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, humanReplayAnalysisMarkdown(report)),
  ]);
  return { directory, jsonPath, markdownPath };
}

export function humanReplayAnalysisMarkdown(
  report: HumanReplayAnalysisReport,
): string {
  const config = report.replay.config;
  const configLine = [
    valueFor(config.gameMap),
    valueFor(config.gameMapSize),
    valueFor(config.gameMode),
    valueFor(config.difficulty),
  ]
    .filter(Boolean)
    .join(" / ");
  const topRows = report.topCandidates.map((player) => {
    const cells = [
      String(player.rank),
      playerName(player),
      player.winner ? "yes" : "",
      player.survivedToEnd ? "yes" : `turn ${player.killedAtTurn ?? "?"}`,
      formatNumber(player.compositeScore),
      formatMinute(player.actionProfile.firstActionMinute.attack),
      formatMinute(player.actionProfile.firstActionMinute.boat),
      String(
        player.actionProfile.phaseCounts.opening?.attack ??
          player.actionProfile.phaseCounts["0-5m"]?.attack ??
          0,
      ),
      String(player.stats.transportsSent),
      String(player.stats.tradeShipsSent),
      formatCompact(player.stats.tradeGold),
      formatCompact(player.actionProfile.troopSums.targetedAttackTroops),
      player.tacticTags.join(", "),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  const baselineRows = Object.entries(report.humanBaselines)
    .filter(([key]) => key !== "topPlayerCount")
    .map(([key, value]) => `| ${key} | ${formatBaseline(value)} |`);
  const signalSections = report.tacticSignals.map((signal) =>
    [
      `### ${signal.label}`,
      "",
      signal.summary,
      "",
      ...signal.evidence.map((line) => `- ${line}`),
      "",
      `Example players: ${signal.examplePlayers.join(", ") || "none"}`,
    ].join("\n"),
  );
  const guidelineRows = report.skillGuidelineCandidates.map(
    (candidate) =>
      `| ${candidate.tacticID} | ${candidate.title} | ${candidate.guideline} |`,
  );

  return [
    `# Human Replay Analysis: ${report.gameID}`,
    "",
    `Generated: ${report.generatedAt}`,
    report.source ? `Source: ${report.source}` : null,
    "",
    "## Match",
    "",
    `- Config: ${configLine || "unknown"}`,
    `- Winner: ${report.winner ? playerName(report.winner) : "unknown"}`,
    `- Duration: ${formatDuration(report.replay.durationSeconds)}`,
    `- Archived turns: ${formatNumber(report.replay.archivedTurnCount)}`,
    `- Replay build: ${report.replay.gitCommit ?? "unknown"}`,
    `- Final leaderboard status: ${report.replay.exactFinalLeaderboardNote}`,
    "",
    "## Top Human Candidates",
    "",
    "| # | Player | Winner | Survived | Score | First Attack | First Boat | Opening Attacks | Transports | Trade Ships | Trade Gold | Targeted Troops | Tags |",
    "| - | - | - | - | -: | -: | -: | -: | -: | -: | -: | -: | - |",
    ...topRows,
    "",
    "## Human Timing Baselines",
    "",
    "| Metric | Top-candidate median |",
    "| - | -: |",
    ...baselineRows,
    "",
    "## Tactic Signals",
    "",
    ...signalSections,
    "",
    "## Skill Guideline Candidates",
    "",
    "| Tactic | Lesson | Candidate Guideline |",
    "| - | - | - |",
    ...guidelineRows,
    "",
    "## LLM Review Packet",
    "",
    "Use this packet for the offline researcher. It should turn one human-replay lesson into a small canonical agent experiment.",
    "",
    "```json",
    JSON.stringify(report.llmReviewPacket, null, 2),
    "```",
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function humanReplayCorpusMarkdown(
  report: HumanReplayCorpusReport,
): string {
  const replayRows = report.replayLinks.map(
    (link) =>
      `| ${link.gameID} | ${link.winner ?? "unknown"} | ${link.config} | ${link.workerPath} | ${link.replayUrl} |`,
  );
  const baselineRows = Object.entries(report.aggregateBaselines)
    .filter(([key]) => key !== "topPlayerCount")
    .map(([key, value]) => `| ${key} | ${formatBaseline(value)} |`);
  const winnerBaselineRows = Object.entries(report.winnerBaselines)
    .filter(([key]) => key !== "topPlayerCount")
    .map(([key, value]) => `| ${key} | ${formatBaseline(value)} |`);
  const frequencyRows = Object.entries(report.tacticFrequencies)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => `| ${tag} | ${count} |`);
  const winnerFrequencyRows = Object.entries(report.winnerTacticFrequencies)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => `| ${tag} | ${count} |`);
  const playerRows = report.topPlayers.map(
    (player) =>
      `| ${player.gameID} | ${player.username} | ${player.winner ? "yes" : ""} | ${formatMinute(player.firstAttackMinute)} | ${formatMinute(player.firstBoatMinute)} | ${player.openingAttackCount} | ${player.transportsSent} | ${player.tradeShipsSent} | ${formatCompact(player.tradeGold)} | ${formatCompact(player.targetedAttackTroops)} | ${player.tacticTags.join(", ")} |`,
  );
  const winnerRows = report.winnerPlayers.map(
    (player) =>
      `| ${player.gameID} | ${player.username} | ${formatMinute(player.firstAttackMinute)} | ${formatMinute(player.firstBoatMinute)} | ${player.openingAttackCount} | ${player.transportsSent} | ${player.tradeShipsSent} | ${formatCompact(player.tradeGold)} | ${formatCompact(player.targetedAttackTroops)} | ${player.tacticTags.join(", ")} |`,
  );
  const recommendationRows = report.agentBehaviorRecommendations.map(
    (recommendation) =>
      `| ${recommendation.tacticID} | ${recommendation.title} | ${recommendation.guideline} |`,
  );

  return [
    `# Human Replay Corpus: ${report.corpusID}`,
    "",
    `Generated: ${report.generatedAt}`,
    `Source: ${report.source}`,
    `Games analyzed: ${report.gameCount}`,
    "",
    "## Replay Links",
    "",
    "| Game | Winner | Config | Worker | Replay URL |",
    "| - | - | - | - | - |",
    ...replayRows,
    "",
    "## Link Generation",
    "",
    `- Format: ${report.linkGeneration.format}`,
    `- Game IDs: ${report.linkGeneration.gameIDSource}`,
    `- Worker path: ${report.linkGeneration.workerPathRule}`,
    `- ID rule: ${report.linkGeneration.gameIDRule}`,
    "",
    "## Aggregate Human Baselines",
    "",
    "| Metric | Median across top candidates |",
    "| - | -: |",
    ...baselineRows,
    "",
    "## Winner-Only Baselines",
    "",
    "| Metric | Median across winners |",
    "| - | -: |",
    ...winnerBaselineRows,
    "",
    "## Tactic Frequency",
    "",
    "| Tactic tag | Top-candidate count |",
    "| - | -: |",
    ...frequencyRows,
    "",
    "## Winner Tactic Frequency",
    "",
    "| Tactic tag | Winner count |",
    "| - | -: |",
    ...winnerFrequencyRows,
    "",
    "## Top Candidate Sample",
    "",
    "| Game | Player | Winner | First Attack | First Boat | Opening Attacks | Transports | Trade Ships | Trade Gold | Targeted Troops | Tags |",
    "| - | - | - | -: | -: | -: | -: | -: | -: | -: | - |",
    ...playerRows,
    "",
    "## Winner Sample",
    "",
    "| Game | Winner | First Attack | First Boat | Opening Attacks | Transports | Trade Ships | Trade Gold | Targeted Troops | Tags |",
    "| - | - | -: | -: | -: | -: | -: | -: | -: | - |",
    ...winnerRows,
    "",
    "## Insights",
    "",
    ...report.insights.map((insight) => `- ${insight}`),
    "",
    "## Agent Behavior Recommendations",
    "",
    "| Tactic | Lesson | Candidate Guideline |",
    "| - | - | - |",
    ...recommendationRows,
    "",
    "## LLM Review Packet",
    "",
    "```json",
    JSON.stringify(report.llmReviewPacket, null, 2),
    "```",
    "",
  ].join("\n");
}

export function openFrontReplayUrl(
  gameID: string,
  origin = "https://openfront.io",
): string {
  return `${origin.replace(/\/$/, "")}/${productionWorkerPath(gameID)}/game/${encodeURIComponent(gameID)}?replay`;
}

export function productionWorkerPath(gameID: string): string {
  return `w${simpleHash(gameID) % 20}`;
}

function summarizePlayer(
  accumulator: PlayerAccumulator,
): HumanReplayPlayerSummary {
  const stats = accumulator.stats;
  const profile = accumulator.actionProfile;
  const survivedToEnd =
    accumulator.player.stats !== null &&
    accumulator.player.stats !== undefined &&
    accumulator.player.stats.killedAt === undefined;
  const killedAtTurn = statNumber(accumulator.player.stats?.killedAt);
  const scoreBreakdown = {
    outcome: accumulator.winner ? 100 : 0,
    survival: survivedToEnd ? 20 : 0,
    expansion:
      stats.conquests * 1.5 +
      stats.citiesCaptured * 0.8 +
      stats.factoriesCaptured * 1.1 +
      stats.portsCaptured * 0.7,
    economy:
      stats.workerGold / 1_000_000 +
      stats.warGold / 2_000_000 +
      stats.tradeGold / 5_000_000 +
      stats.stolenTradeGold / 5_000_000 +
      stats.citiesBuilt * 0.7 +
      stats.factoriesBuilt * 1.2 +
      stats.portsBuilt * 0.7,
    naval:
      stats.transportsSent * 0.25 +
      stats.tradeShipsSent * 0.04 +
      stats.warshipsBuilt * 0.8 +
      profile.troopSums.boatTroops / 10_000_000,
    pressure:
      stats.attacksSent / 10_000_000 +
      profile.troopSums.targetedAttackTroops / 10_000_000,
    endgame:
      stats.atomBombsLaunched * 0.5 +
      stats.hydrogenBombsLaunched * 1.2 +
      stats.mirvsLaunched * 3 +
      Math.min(stats.mirvWarheadsLaunched, 60) * 0.12 +
      stats.silosBuilt * 0.7 +
      stats.samLaunchersBuilt * 0.4,
  };
  const compositeScore = round1(
    scoreBreakdown.outcome +
      scoreBreakdown.survival +
      scoreBreakdown.expansion +
      scoreBreakdown.economy +
      scoreBreakdown.naval +
      scoreBreakdown.pressure +
      scoreBreakdown.endgame,
  );
  return {
    rank: 0,
    username: accumulator.player.username,
    clientID: accumulator.player.clientID,
    clanTag: accumulator.player.clanTag ?? null,
    winner: accumulator.winner,
    survivedToEnd,
    killedAtTurn,
    compositeScore,
    scoreBreakdown: mapNumberValues(scoreBreakdown, round1),
    stats,
    actionProfile: profile,
    tacticTags: tacticTags(stats, profile),
  };
}

function summarizeStats(
  stats: HumanReplayStats | null,
): HumanReplayPlayerStatsSummary {
  const city = stats?.units?.city;
  const fact = stats?.units?.fact;
  const port = stats?.units?.port;
  const defp = stats?.units?.defp;
  const wshp = stats?.units?.wshp;
  const silo = stats?.units?.silo;
  const saml = stats?.units?.saml;
  const bombs = stats?.bombs ?? {};
  const units = stats?.units ?? {};
  return {
    attacksSent: statNumber(stats?.attacks?.[0]),
    attacksReceived: statNumber(stats?.attacks?.[1]),
    attacksCancelled: statNumber(stats?.attacks?.[2]),
    conquests: sumStatArray(stats?.conquests),
    betrayals: statNumber(stats?.betrayals),
    transportsSent: statNumber(stats?.boats?.trans?.[0]),
    transportsArrived: statNumber(stats?.boats?.trans?.[1]),
    transportsCaptured: statNumber(stats?.boats?.trans?.[2]),
    transportsDestroyed: statNumber(stats?.boats?.trans?.[3]),
    tradeShipsSent: statNumber(stats?.boats?.trade?.[0]),
    tradeShipsArrived: statNumber(stats?.boats?.trade?.[1]),
    tradeShipsCaptured: statNumber(stats?.boats?.trade?.[2]),
    tradeShipsDestroyed: statNumber(stats?.boats?.trade?.[3]),
    workerGold: statNumber(stats?.gold?.[0]),
    warGold: statNumber(stats?.gold?.[1]),
    tradeGold: statNumber(stats?.gold?.[2]),
    stolenTradeGold: statNumber(stats?.gold?.[3]),
    trainSelfGold: statNumber(stats?.gold?.[4]),
    trainOtherGold: statNumber(stats?.gold?.[5]),
    totalGold: sumStatArray(stats?.gold),
    bombsLaunched: sumBombIndex(bombs, 0),
    bombsLanded: sumBombIndex(bombs, 1),
    bombsIntercepted: sumBombIndex(bombs, 2),
    atomBombsLaunched: statNumber(bombs.abomb?.[0]),
    hydrogenBombsLaunched: statNumber(bombs.hbomb?.[0]),
    mirvsLaunched: statNumber(bombs.mirv?.[0]),
    mirvWarheadsLaunched: statNumber(bombs.mirvw?.[0]),
    citiesBuilt: statNumber(city?.[0]),
    citiesCaptured: statNumber(city?.[2]),
    factoriesBuilt: statNumber(fact?.[0]),
    factoriesCaptured: statNumber(fact?.[2]),
    portsBuilt: statNumber(port?.[0]),
    portsCaptured: statNumber(port?.[2]),
    defensePostsBuilt: statNumber(defp?.[0]),
    warshipsBuilt: statNumber(wshp?.[0]),
    silosBuilt: statNumber(silo?.[0]),
    samLaunchersBuilt: statNumber(saml?.[0]),
    totalStructuresBuilt: sumUnitIndex(units, 0),
    totalStructuresCaptured: sumUnitIndex(units, 2),
    totalStructuresLost: sumUnitIndex(units, 3),
  };
}

function emptyActionProfile(): HumanReplayActionProfile {
  return {
    firstActionTurn: {},
    firstActionMinute: {},
    actionCounts: {},
    phaseCounts: Object.fromEntries(
      DEFAULT_PHASES.map((phase) => [phase.id, {}]),
    ),
    buildCounts: {},
    troopSums: {
      boatTroops: 0,
      attackTroops: 0,
      neutralAttackTroops: 0,
      targetedAttackTroops: 0,
    },
  };
}

function recordIntent(
  profile: HumanReplayActionProfile,
  intent: HumanReplayIntent,
  turnNumber: number,
  turnsPerMinute: number,
) {
  const actionType = intent.type;
  profile.actionCounts[actionType] =
    (profile.actionCounts[actionType] ?? 0) + 1;
  if (profile.firstActionTurn[actionType] === undefined) {
    profile.firstActionTurn[actionType] = turnNumber;
    profile.firstActionMinute[actionType] = round2(turnNumber / turnsPerMinute);
  }
  const phase = phaseForMinute(turnNumber / turnsPerMinute).id;
  const phaseCounts = profile.phaseCounts[phase] ?? {};
  phaseCounts[actionType] = (phaseCounts[actionType] ?? 0) + 1;
  profile.phaseCounts[phase] = phaseCounts;

  if (actionType === "build_unit" && intent.unit) {
    profile.buildCounts[intent.unit] =
      (profile.buildCounts[intent.unit] ?? 0) + 1;
  }
  if (actionType === "boat") {
    profile.troopSums.boatTroops += statNumber(intent.troops);
  }
  if (actionType === "attack") {
    const troops = statNumber(intent.troops);
    profile.troopSums.attackTroops += troops;
    if (intent.targetID === null || intent.targetID === undefined) {
      profile.troopSums.neutralAttackTroops += troops;
    } else {
      profile.troopSums.targetedAttackTroops += troops;
    }
  }
}

function hasMeaningfulPlay(accumulator: PlayerAccumulator): boolean {
  return (
    accumulator.winner ||
    accumulator.player.stats !== null ||
    Object.keys(accumulator.actionProfile.actionCounts).some(
      (key) => key !== "mark_disconnected",
    )
  );
}

function comparePlayerSummaries(
  left: HumanReplayPlayerSummary,
  right: HumanReplayPlayerSummary,
): number {
  if (left.winner !== right.winner) {
    return left.winner ? -1 : 1;
  }
  return right.compositeScore - left.compositeScore;
}

function buildHumanBaselines(
  topCandidates: HumanReplayPlayerSummary[],
): HumanReplayHumanBaselines {
  return {
    topPlayerCount: topCandidates.length,
    medianFirstAttackMinute: median(
      topCandidates.map(
        (player) => player.actionProfile.firstActionMinute.attack,
      ),
    ),
    medianFirstBoatMinute: median(
      topCandidates.map(
        (player) => player.actionProfile.firstActionMinute.boat,
      ),
    ),
    medianFirstBuildMinute: median(
      topCandidates.map(
        (player) => player.actionProfile.firstActionMinute.build_unit,
      ),
    ),
    medianOpeningAttackCount: median(
      topCandidates.map(
        (player) => player.actionProfile.phaseCounts.opening.attack,
      ),
    ),
    medianOpeningBoatCount: median(
      topCandidates.map(
        (player) => player.actionProfile.phaseCounts.opening.boat,
      ),
    ),
    medianTransportSent: median(
      topCandidates.map((player) => player.stats.transportsSent),
    ),
    medianTradeShipsSent: median(
      topCandidates.map((player) => player.stats.tradeShipsSent),
    ),
    medianTradeGold: median(
      topCandidates.map((player) => player.stats.tradeGold),
    ),
    medianTargetedAttackTroops: median(
      topCandidates.map(
        (player) => player.actionProfile.troopSums.targetedAttackTroops,
      ),
    ),
    medianCapturedCities: median(
      topCandidates.map((player) => player.stats.citiesCaptured),
    ),
    medianCapturedFactories: median(
      topCandidates.map((player) => player.stats.factoriesCaptured),
    ),
    medianCapturedPorts: median(
      topCandidates.map((player) => player.stats.portsCaptured),
    ),
  };
}

function buildHumanBaselinesFromCorpus(
  players: HumanReplayCorpusPlayerSummary[],
): HumanReplayHumanBaselines {
  return {
    topPlayerCount: players.length,
    medianFirstAttackMinute: median(
      players.map((player) => player.firstAttackMinute),
    ),
    medianFirstBoatMinute: median(
      players.map((player) => player.firstBoatMinute),
    ),
    medianFirstBuildMinute: null,
    medianOpeningAttackCount: median(
      players.map((player) => player.openingAttackCount),
    ),
    medianOpeningBoatCount: null,
    medianTransportSent: median(players.map((player) => player.transportsSent)),
    medianTradeShipsSent: median(
      players.map((player) => player.tradeShipsSent),
    ),
    medianTradeGold: median(players.map((player) => player.tradeGold)),
    medianTargetedAttackTroops: median(
      players.map((player) => player.targetedAttackTroops),
    ),
    medianCapturedCities: median(
      players.map((player) => player.capturedCities),
    ),
    medianCapturedFactories: median(
      players.map((player) => player.capturedFactories),
    ),
    medianCapturedPorts: median(players.map((player) => player.capturedPorts)),
  };
}

function tacticFrequenciesForPlayers(
  players: HumanReplayCorpusPlayerSummary[],
): Record<string, number> {
  return players.reduce<Record<string, number>>((frequencies, player) => {
    for (const tag of player.tacticTags) {
      frequencies[tag] = (frequencies[tag] ?? 0) + 1;
    }
    return frequencies;
  }, {});
}

function corpusPlayerSummary(
  gameID: string,
  player: HumanReplayPlayerSummary,
): HumanReplayCorpusPlayerSummary {
  return {
    gameID,
    replayUrl: openFrontReplayUrl(gameID),
    rank: player.rank,
    username: playerName(player),
    clientID: player.clientID,
    winner: player.winner,
    compositeScore: player.compositeScore,
    firstAttackMinute: player.actionProfile.firstActionMinute.attack ?? null,
    firstBoatMinute: player.actionProfile.firstActionMinute.boat ?? null,
    openingAttackCount: player.actionProfile.phaseCounts.opening.attack ?? 0,
    transportsSent: player.stats.transportsSent,
    tradeShipsSent: player.stats.tradeShipsSent,
    tradeGold: player.stats.tradeGold,
    targetedAttackTroops: player.actionProfile.troopSums.targetedAttackTroops,
    capturedCities: player.stats.citiesCaptured,
    capturedFactories: player.stats.factoriesCaptured,
    capturedPorts: player.stats.portsCaptured,
    tacticTags: player.tacticTags,
  };
}

function humanReplayLink(analysis: HumanReplayAnalysisReport): HumanReplayLink {
  const config = analysis.replay.config;
  return {
    gameID: analysis.gameID,
    replayUrl: openFrontReplayUrl(analysis.gameID),
    workerPath: productionWorkerPath(analysis.gameID),
    winner: analysis.winner === null ? null : playerName(analysis.winner),
    config: [
      valueFor(config.gameMap),
      valueFor(config.gameMapSize),
      valueFor(config.gameMode),
      valueFor(config.difficulty),
    ]
      .filter(Boolean)
      .join(" / "),
  };
}

function corpusGuidelineCandidates(
  baselines: HumanReplayHumanBaselines,
  tacticFrequencies: Record<string, number>,
): HumanReplaySkillGuidelineCandidate[] {
  return [
    {
      tacticID: "opening_expansion_tempo",
      title: "Human openings expand before one minute.",
      evidence: `Corpus median first attack was ${formatMinute(
        baselines.medianFirstAttackMinute,
      )}; median opening attacks was ${formatBaseline(
        baselines.medianOpeningAttackCount,
      )}.`,
      guideline:
        "During the first 5 minutes, force a safe neutral growth action over static defense or diplomacy when behind the human opening baseline and home danger is not high.",
    },
    {
      tacticID: "transport_troop_banking",
      title: "Human openings add boats early and often.",
      evidence: `Corpus median first boat was ${formatMinute(
        baselines.medianFirstBoatMinute,
      )}; median transports sent was ${formatBaseline(
        baselines.medianTransportSent,
      )}.`,
      guideline:
        "Treat early neutral boats as part of expansion tempo, and use near-cap transports as troop banking when no urgent land conversion is available.",
    },
    {
      tacticID: "trade_economy",
      title: "Winning pressure is funded by trade.",
      evidence: `Corpus median trade ships sent was ${formatBaseline(
        baselines.medianTradeShipsSent,
      )}; median trade gold was ${formatCompact(
        baselines.medianTradeGold ?? 0,
      )}; trade_economy appeared ${tacticFrequencies.trade_economy ?? 0} times.`,
      guideline:
        "Do not let pressure plans disable economy/naval modules; keep ports, trade, cities, and factories eligible while attacking.",
    },
    {
      tacticID: "frontier_conversion_pressure",
      title: "Strong humans convert structures from rivals.",
      evidence: `Corpus median captured city/factory/port counts were ${formatBaseline(
        baselines.medianCapturedCities,
      )}/${formatBaseline(baselines.medianCapturedFactories)}/${formatBaseline(
        baselines.medianCapturedPorts,
      )}.`,
      guideline:
        "When a rival is reachable, weaker, and structure-rich, refresh stale growth plans into focused pressure instead of farming neutral land indefinitely.",
    },
  ];
}

function corpusInsights(
  baselines: HumanReplayHumanBaselines,
  winnerBaselines: HumanReplayHumanBaselines,
  tacticFrequencies: Record<string, number>,
  winnerTacticFrequencies: Record<string, number>,
  players: HumanReplayCorpusPlayerSummary[],
  winnerPlayers: HumanReplayCorpusPlayerSummary[],
): string[] {
  return [
    `Across ${players.length} top-candidate rows, median first attack was ${formatMinute(
      baselines.medianFirstAttackMinute,
    )}; this supports hard opening expansion bias.`,
    `Across ${winnerPlayers.length} winner rows, median first attack was ${formatMinute(
      winnerBaselines.medianFirstAttackMinute,
    )}, median first boat was ${formatMinute(
      winnerBaselines.medianFirstBoatMinute,
    )}, and median transports sent was ${formatBaseline(
      winnerBaselines.medianTransportSent,
    )}.`,
    `Median first boat was ${formatMinute(
      baselines.medianFirstBoatMinute,
    )}, so neutral or pressure transports should be treated as normal tempo, not rare escape behavior.`,
    `Median trade ships sent was ${formatBaseline(
      baselines.medianTradeShipsSent,
    )}, with median trade gold ${formatCompact(
      baselines.medianTradeGold ?? 0,
    )}; human pressure depends on compounding economy.`,
    `transport_banking appeared ${
      tacticFrequencies.transport_banking ?? 0
    } times and targeted_pressure appeared ${
      tacticFrequencies.targeted_pressure ?? 0
    } times among top candidates.`,
    `Among winners, transport_banking appeared ${
      winnerTacticFrequencies.transport_banking ?? 0
    } times, trade_economy appeared ${
      winnerTacticFrequencies.trade_economy ?? 0
    } times, and structure_conversion appeared ${
      winnerTacticFrequencies.structure_conversion ?? 0
    } times.`,
  ];
}

function buildTacticSignals(
  topCandidates: HumanReplayPlayerSummary[],
  baselines: HumanReplayHumanBaselines,
): HumanReplayTacticSignal[] {
  const firstAttackPlayers = topCandidates.filter(
    (player) =>
      (player.actionProfile.firstActionMinute.attack ?? Infinity) <= 1,
  );
  const earlyBoatPlayers = topCandidates.filter(
    (player) => (player.actionProfile.firstActionMinute.boat ?? Infinity) <= 2,
  );
  const tradePlayers = topCandidates.filter(
    (player) =>
      player.stats.tradeShipsSent >= 100 ||
      player.stats.tradeGold >= 10_000_000,
  );
  const conversionPlayers = topCandidates.filter(
    (player) =>
      player.actionProfile.troopSums.targetedAttackTroops >
      Math.max(1, player.actionProfile.troopSums.neutralAttackTroops),
  );
  const endgamePlayers = topCandidates.filter(
    (player) =>
      player.stats.hydrogenBombsLaunched > 0 ||
      player.stats.atomBombsLaunched > 0 ||
      player.stats.mirvsLaunched > 0,
  );

  return [
    {
      tacticID: "opening_expansion_tempo",
      label: "Opening Expansion Tempo",
      summary:
        "Strong human candidates start taking land almost immediately instead of waiting for perfect builds or diplomacy.",
      evidence: [
        `Median first attack: ${formatMinute(baselines.medianFirstAttackMinute)}.`,
        `Median opening attacks: ${formatBaseline(baselines.medianOpeningAttackCount)}.`,
      ],
      examplePlayers: firstAttackPlayers.map(playerName),
    },
    {
      tacticID: "transport_troop_banking",
      label: "Transport Troop Banking / Naval Projection",
      summary:
        "Top candidates launch boats early enough that ships become part of the growth plan, not only a late-game escape hatch.",
      evidence: [
        `Median first boat: ${formatMinute(baselines.medianFirstBoatMinute)}.`,
        `Median transports sent: ${formatBaseline(baselines.medianTransportSent)}.`,
      ],
      examplePlayers: earlyBoatPlayers.map(playerName),
    },
    {
      tacticID: "trade_economy",
      label: "Trade Economy",
      summary:
        "The strongest human profiles pair conquest with heavy trade income, which funds builds, nukes, and pressure.",
      evidence: [
        `Median trade ships sent: ${formatBaseline(baselines.medianTradeShipsSent)}.`,
        `Median trade gold: ${formatCompact(baselines.medianTradeGold ?? 0)}.`,
      ],
      examplePlayers: tradePlayers.map(playerName),
    },
    {
      tacticID: "frontier_conversion_pressure",
      label: "Frontier Conversion Pressure",
      summary:
        "After opening growth, strong humans shift large troop volumes into targeted player attacks instead of only neutral cleanup.",
      evidence: [
        `Median targeted attack troops: ${formatCompact(baselines.medianTargetedAttackTroops ?? 0)}.`,
        `Median captured cities/factories/ports: ${formatBaseline(
          baselines.medianCapturedCities,
        )}/${formatBaseline(baselines.medianCapturedFactories)}/${formatBaseline(
          baselines.medianCapturedPorts,
        )}.`,
      ],
      examplePlayers: conversionPlayers.map(playerName),
    },
    {
      tacticID: "endgame_weapon_pressure",
      label: "Endgame Weapon Pressure",
      summary:
        "High-performing survivors invest in silos, SAMs, atomic weapons, hydrogen bombs, or MIRVs once the economy can support them.",
      evidence: topCandidates.map(
        (player) =>
          `${playerName(player)} launched ${player.stats.atomBombsLaunched} atom, ${player.stats.hydrogenBombsLaunched} hydrogen, ${player.stats.mirvsLaunched} MIRV, and ${player.stats.mirvWarheadsLaunched} MIRV warhead actions.`,
      ),
      examplePlayers: endgamePlayers.map(playerName),
    },
  ];
}

function buildSkillGuidelineCandidates(
  topCandidates: HumanReplayPlayerSummary[],
  baselines: HumanReplayHumanBaselines,
): HumanReplaySkillGuidelineCandidate[] {
  const winner =
    topCandidates.find((player) => player.winner) ?? topCandidates[0];
  return [
    {
      tacticID: "opening_expansion_tempo",
      title: "Treat sub-1-minute neutral expansion as the human baseline.",
      evidence: `Top-candidate median first attack was ${formatMinute(
        baselines.medianFirstAttackMinute,
      )}; ${winner ? `${playerName(winner)} first attacked at ${formatMinute(winner.actionProfile.firstActionMinute.attack)}.` : "winner timing unavailable"}`,
      guideline:
        "In the opening, keep growth active whenever safe neutral attack or transport expansion is legal; do not stall on unavailable builds or broad diplomacy.",
    },
    {
      tacticID: "transport_troop_banking",
      title: "Use transports as growth and troop-bank tools.",
      evidence: `Top-candidate median transports sent was ${formatBaseline(
        baselines.medianTransportSent,
      )}; median first boat was ${formatMinute(baselines.medianFirstBoatMinute)}.`,
      guideline:
        "When near troop cap and home danger is low, prefer safe transport launches that create future landing pressure while home population regrows.",
    },
    {
      tacticID: "trade_economy",
      title: "Do not let pressure replace trade economy.",
      evidence: `Top-candidate median trade ships sent was ${formatBaseline(
        baselines.medianTradeShipsSent,
      )}, producing median trade gold ${formatCompact(baselines.medianTradeGold ?? 0)}.`,
      guideline:
        "Keep economy/naval modules available during pressure plans so ports, trade, factories, and cities continue funding late-game tools.",
    },
    {
      tacticID: "frontier_conversion_pressure",
      title:
        "Switch from neutral growth to player conversion once targets are weak.",
      evidence: `Top-candidate median targeted attack troops was ${formatCompact(
        baselines.medianTargetedAttackTroops ?? 0,
      )}; captured city/factory/port medians were ${formatBaseline(
        baselines.medianCapturedCities,
      )}/${formatBaseline(baselines.medianCapturedFactories)}/${formatBaseline(
        baselines.medianCapturedPorts,
      )}.`,
      guideline:
        "When a reachable rival is weak enough and reserves are healthy, shorten the plan and let combat finish the target instead of repeatedly choosing side growth or passive builds.",
    },
  ];
}

function tacticTags(
  stats: HumanReplayPlayerStatsSummary,
  profile: HumanReplayActionProfile,
): string[] {
  const tags: string[] = [];
  if ((profile.firstActionMinute.attack ?? Infinity) <= 1) {
    tags.push("fast_opening");
  }
  if ((profile.firstActionMinute.boat ?? Infinity) <= 2) {
    tags.push("early_boats");
  }
  if (
    stats.transportsSent >= 40 ||
    profile.troopSums.boatTroops >= 20_000_000
  ) {
    tags.push("transport_banking");
  }
  if (stats.tradeShipsSent >= 100 || stats.tradeGold >= 10_000_000) {
    tags.push("trade_economy");
  }
  if (
    profile.troopSums.targetedAttackTroops >
    Math.max(1, profile.troopSums.neutralAttackTroops)
  ) {
    tags.push("targeted_pressure");
  }
  if (
    stats.citiesCaptured + stats.factoriesCaptured + stats.portsCaptured >=
    25
  ) {
    tags.push("structure_conversion");
  }
  if (stats.portsBuilt >= 5 || stats.warshipsBuilt >= 8) {
    tags.push("naval_control");
  }
  if (
    stats.atomBombsLaunched +
      stats.hydrogenBombsLaunched +
      stats.mirvsLaunched +
      stats.mirvWarheadsLaunched >
    0
  ) {
    tags.push("endgame_weapons");
  }
  return tags;
}

function phaseForMinute(minute: number): HumanReplayPhaseDefinition {
  return (
    DEFAULT_PHASES.find(
      (phase) =>
        minute >= phase.startMinute &&
        (phase.endMinute === null || minute < phase.endMinute),
    ) ?? DEFAULT_PHASES[DEFAULT_PHASES.length - 1]
  );
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

function sumBombIndex(
  bombs: Record<string, StatArray | undefined>,
  index: number,
): number {
  return Object.values(bombs).reduce(
    (sum, values) => sum + statNumber(values?.[index]),
    0,
  );
}

function sumUnitIndex(
  units: Record<string, StatArray | undefined>,
  index: number,
): number {
  return Object.values(units).reduce(
    (sum, values) => sum + statNumber(values?.[index]),
    0,
  );
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

function median(values: Array<number | null | undefined>): number | null {
  const finite = values
    .filter((value): value is number => typeof value === "number")
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (finite.length === 0) {
    return null;
  }
  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2 === 1) {
    return round2(finite[middle]);
  }
  return round2((finite[middle - 1] + finite[middle]) / 2);
}

function valueFor(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function playerName(
  player: Pick<HumanReplayPlayerSummary, "username" | "clanTag">,
) {
  return player.clanTag
    ? `[${player.clanTag}] ${player.username}`
    : player.username;
}

function formatMinute(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${round2(value)}m`
    : "n/a";
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "unknown";
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function formatBaseline(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatNumber(value)
    : "n/a";
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${round1(value / 1_000_000)}M`;
  }
  if (abs >= 1_000) {
    return `${round1(value / 1_000)}k`;
  }
  return formatNumber(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
    value,
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mapNumberValues<T extends Record<string, number>>(
  input: T,
  transform: (value: number) => number,
): T {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, transform(value)]),
  ) as T;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash &= hash;
  }
  return Math.abs(hash);
}
