import fs from "fs/promises";
import path from "path";
import { AgentBrainType, AgentDecisionRecord } from "./AgentTypes";
import {
  AgentRunFinalState,
  AgentRunRosterEntry,
} from "./AgentDecisionLogWriter";
import {
  buildAgentSpectatorTelemetry,
  SpectatorEvent,
} from "./AgentSpectatorTelemetry";

/**
 * Post-hoc "interestingness" scorer for the LLM-agent league. It reduces the
 * existing spectator event/relationship graph to a small set of drama scalars so
 * the self-improvement loop can reward politics/betrayal/comebacks instead of
 * treating them as noise. Pure function of the recorded match — no LLM calls.
 *
 * NOTE: politics only EXIST between independent agent policies. In a single
 * agent-vs-nations match the spectator graph has <2 agent actors, so the drama
 * scalars are ~0 by construction; this is expected, not a failure (see notes[]).
 * Real drama is produced by self-play (multiple LLM brains in one match).
 */
export interface AgentDramaReportInput {
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  records: AgentDecisionRecord[];
  roster: AgentRunRosterEntry[];
  finalState?: AgentRunFinalState;
}

export interface AgentDramaAgentPolitics {
  agentID: string;
  username: string;
  alliancesFormed: number;
  /** Alliances this agent broke = betrayals it committed. */
  alliancesBroken: number;
  /** Allies that broke their alliance with this agent. */
  betrayalsSuffered: number;
  attacksInitiated: number;
  /** Distinct rivals this agent was in a mutual (two-way) war with. */
  warsInvolved: number;
  finalTilesOwned: number | null;
  isAlive: boolean | null;
}

export interface AgentDramaMoment {
  turnNumber: number;
  kind: string;
  tone: string;
  importance: number;
  actor: string;
  target: string | null;
  message: string;
}

export type AgentDramaGrade = "flat" | "mild" | "lively" | "dramatic";

export interface AgentDramaReport {
  schemaVersion: 1;
  reportKind: "drama-and-tom-scorer";
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  generatedAt: string;
  /** Agent (non-tribe) actors present; politics require >= 2. */
  politicalActorCount: number;
  allianceFormedCount: number;
  allianceBrokenCount: number;
  /** Betrayals = active alliance breaks (each carries the betrayal tone). */
  betrayalCount: number;
  /** Distinct pairs that traded attacks in both directions. */
  mutualWarCount: number;
  eliminationCount: number;
  communicationCount: number;
  highImportanceEventCount: number;
  /** Betrayals where the breaker ended ahead of (or eliminated) the betrayed ally. */
  betrayalsPaidOff: number;
  /** 0..100 composite — higher = more political/interesting. */
  dramaScore: number;
  dramaGrade: AgentDramaGrade;
  topMoments: AgentDramaMoment[];
  agents: AgentDramaAgentPolitics[];
  notes: string[];
}

export interface AgentDramaReportPaths {
  jsonPath: string;
  markdownPath: string;
}

const HIGH_IMPORTANCE_THRESHOLD = 80;
const COMMUNICATION_KINDS = new Set<SpectatorEvent["kind"]>([
  "chat",
  "emoji",
  "alliance_request",
  "target_call",
]);

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function dramaGradeFor(score: number): AgentDramaGrade {
  if (score < 15) {
    return "flat";
  }
  if (score < 40) {
    return "mild";
  }
  if (score < 70) {
    return "lively";
  }
  return "dramatic";
}

export function buildAgentDramaReport(
  input: AgentDramaReportInput,
): AgentDramaReport {
  const telemetry = buildAgentSpectatorTelemetry({
    runID: input.runID,
    records: input.records,
    roster: input.roster,
    finalState: input.finalState,
  });
  const events = telemetry.events;
  const finalTilesByAgent = new Map(
    telemetry.agents.map((agent) => [agent.agentID, agent.finalTilesOwned]),
  );
  const aliveByAgent = new Map(
    telemetry.agents.map((agent) => [agent.agentID, agent.isAlive]),
  );

  const countKind = (kind: SpectatorEvent["kind"]): number =>
    events.filter((event) => event.kind === kind).length;

  const allianceFormedCount = countKind("alliance_formed");
  const allianceBrokenCount = countKind("alliance_break");
  const eliminationCount = countKind("elimination");
  const communicationCount = events.filter((event) =>
    COMMUNICATION_KINDS.has(event.kind),
  ).length;
  const highImportanceEventCount = events.filter(
    (event) => event.importance >= HIGH_IMPORTANCE_THRESHOLD,
  ).length;

  // Mutual wars: dedupe directed relationships into unordered pairs.
  const mutualWarPairs = new Set<string>();
  for (const relationship of telemetry.relationships) {
    if (relationship.attacksSent > 0 && relationship.attacksReceived > 0) {
      mutualWarPairs.add(
        pairKey(relationship.fromAgentID, relationship.toAgentID),
      );
    }
  }
  const mutualWarCount = mutualWarPairs.size;

  // Outcome-anchored betrayals: did breaking the alliance actually pay off?
  let betrayalsPaidOff = 0;
  for (const event of events) {
    if (event.kind !== "alliance_break" || event.targetAgentID === null) {
      continue;
    }
    const breakerTiles = finalTilesByAgent.get(event.actorAgentID) ?? 0;
    const victimTiles = finalTilesByAgent.get(event.targetAgentID) ?? 0;
    const victimAlive = aliveByAgent.get(event.targetAgentID);
    if ((breakerTiles ?? 0) > (victimTiles ?? 0) || victimAlive === false) {
      betrayalsPaidOff += 1;
    }
  }

  const dramaScore = Math.min(
    100,
    Math.round(
      allianceFormedCount * 8 +
        allianceBrokenCount * 16 +
        mutualWarCount * 6 +
        eliminationCount * 10 +
        betrayalsPaidOff * 6 +
        Math.min(communicationCount, 20) * 0.5,
    ),
  );

  const agents: AgentDramaAgentPolitics[] = telemetry.agents.map((agent) => {
    const asActor = events.filter(
      (event) => event.actorAgentID === agent.agentID,
    );
    const warsInvolved = new Set<string>();
    for (const relationship of telemetry.relationships) {
      if (
        (relationship.fromAgentID === agent.agentID ||
          relationship.toAgentID === agent.agentID) &&
        relationship.attacksSent > 0 &&
        relationship.attacksReceived > 0
      ) {
        warsInvolved.add(
          pairKey(relationship.fromAgentID, relationship.toAgentID),
        );
      }
    }
    return {
      agentID: agent.agentID,
      username: agent.username,
      alliancesFormed: asActor.filter((event) => event.kind === "alliance_formed")
        .length,
      alliancesBroken: asActor.filter((event) => event.kind === "alliance_break")
        .length,
      betrayalsSuffered: events.filter(
        (event) =>
          event.kind === "alliance_break" &&
          event.targetAgentID === agent.agentID,
      ).length,
      attacksInitiated: asActor.filter((event) => event.kind === "attack").length,
      warsInvolved: warsInvolved.size,
      finalTilesOwned: agent.finalTilesOwned,
      isAlive: agent.isAlive,
    };
  });

  const topMoments: AgentDramaMoment[] = [...events]
    .sort((a, b) => b.importance - a.importance || a.turnNumber - b.turnNumber)
    .slice(0, 5)
    .map((event) => ({
      turnNumber: event.turnNumber,
      kind: event.kind,
      tone: event.tone,
      importance: event.importance,
      actor: event.actorName,
      target: event.targetName,
      message: event.message,
    }));

  const politicalActorCount = telemetry.agents.length;
  const notes: string[] = [];
  if (politicalActorCount < 2) {
    notes.push(
      "Single agent actor in this match: politics/betrayal/ToM require >= 2 independent agent policies (self-play). Drama scalars are ~0 by construction here, not a defect.",
    );
  }
  if (politicalActorCount >= 2 && dramaScore === 0) {
    notes.push(
      "Multiple agents but no political events: no alliances, betrayals, or mutual wars occurred this match.",
    );
  }

  return {
    schemaVersion: 1,
    reportKind: "drama-and-tom-scorer",
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    generatedAt: new Date().toISOString(),
    politicalActorCount,
    allianceFormedCount,
    allianceBrokenCount,
    betrayalCount: allianceBrokenCount,
    mutualWarCount,
    eliminationCount,
    communicationCount,
    highImportanceEventCount,
    betrayalsPaidOff,
    dramaScore,
    dramaGrade: dramaGradeFor(dramaScore),
    topMoments,
    agents,
    notes,
  };
}

export async function writeAgentDramaReportArtifacts(input: {
  report: AgentDramaReport;
  directory: string;
}): Promise<AgentDramaReportPaths> {
  const jsonPath = path.join(input.directory, "drama-report.json");
  const markdownPath = path.join(input.directory, "drama-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`);
  await fs.writeFile(markdownPath, dramaReportMarkdown(input.report));
  return { jsonPath, markdownPath };
}

export function dramaReportMarkdown(report: AgentDramaReport): string {
  const lines = [
    `# Drama & ToM Report ${report.runID}`,
    "",
    `- Match id: ${report.matchID}`,
    `- Scenario: ${report.scenario}`,
    `- Brain mode: ${report.brainMode}`,
    `- Drama score: ${report.dramaScore}/100 (${report.dramaGrade})`,
    `- Political agent actors: ${report.politicalActorCount}`,
    `- Alliances formed / broken: ${report.allianceFormedCount} / ${report.allianceBrokenCount}`,
    `- Betrayals (paid off): ${report.betrayalCount} (${report.betrayalsPaidOff})`,
    `- Mutual wars: ${report.mutualWarCount}`,
    `- Eliminations: ${report.eliminationCount}`,
    `- Communications: ${report.communicationCount}`,
    "",
  ];
  if (report.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }
  if (report.topMoments.length > 0) {
    lines.push("## Top moments", "");
    for (const moment of report.topMoments) {
      lines.push(
        `- t${moment.turnNumber} [${moment.kind}/${moment.tone}, ${moment.importance}] ${moment.actor}${
          moment.target ? ` -> ${moment.target}` : ""
        }: ${moment.message}`,
      );
    }
    lines.push("");
  }
  if (report.agents.length > 0) {
    lines.push("## Per-agent politics", "");
    lines.push(
      "| Agent | Allied | Broke | Betrayed | Attacks | Wars | Final tiles | Alive |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | :--: |",
    );
    for (const agent of report.agents) {
      lines.push(
        `| ${agent.username} | ${agent.alliancesFormed} | ${agent.alliancesBroken} | ${agent.betrayalsSuffered} | ${agent.attacksInitiated} | ${agent.warsInvolved} | ${agent.finalTilesOwned ?? "?"} | ${agent.isAlive === null ? "?" : agent.isAlive ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
