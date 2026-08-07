import type {
  AgentRunFinalState,
  AgentRunRosterEntry,
} from "./AgentDecisionLogWriter";
import { economyFactsFromAffordance } from "./AgentEconomyNetwork";
import { economyEventsEnabled } from "./AgentTunables";
import type {
  AgentDecisionRecord,
  AgentEconomyRecordCounterpartyFacts,
  AgentEconomyRecordFacts,
  LegalActionKind,
} from "./AgentTypes";

export type SpectatorRelationshipLabel =
  | "ally"
  | "betrayed"
  | "target"
  | "rival"
  | "neutral";

export type SpectatorAllianceState =
  | "none"
  | "requested"
  | "allied"
  | "broken";

export type SpectatorEventKind =
  | "spawn"
  | "neutral_expansion"
  | "attack"
  | "alliance_request"
  | "alliance_formed"
  | "alliance_break"
  | "trade"
  | "embargo"
  | "target_call"
  | "nuke"
  | "build"
  | "chat"
  | "emoji"
  | "elimination"
  | "hold"
  // Economy events (PROXYWAR_TUNE_ECONOMY_EVENTS, default OFF): derived from
  // per-decision economy facts, emitted on state TRANSITIONS only, bounded per
  // match. publicText keeps physical connection / trade eligibility /
  // relationship / projected value / realized income distinct and never claims
  // an agent routed or stopped a train or ship.
  | "factory_operational"
  | "factory_idle"
  | "trade_link_established"
  | "trade_severed"
  | "economy_dependency";

export interface SpectatorAgent {
  agentID: string;
  playerID: string | null;
  username: string;
  profile: string;
  colorIndex: number;
  finalTilesOwned: number | null;
  finalTroops: number | null;
  isAlive: boolean | null;
}

export interface SpectatorRelationship {
  fromAgentID: string;
  toAgentID: string;
  trust: number;
  distrust: number;
  tension: number;
  allianceState: SpectatorAllianceState;
  tradeGivenGold: number;
  tradeGivenTroops: number;
  attacksSent: number;
  attacksReceived: number;
  betrayals: number;
  lastMajorEventTurn: number | null;
  currentLabel: SpectatorRelationshipLabel;
  reasons: string[];
}

export interface SpectatorEvent {
  id: string;
  sequence: number;
  turnNumber: number;
  kind: SpectatorEventKind;
  tone: "info" | "pact" | "trade" | "threat" | "betrayal" | "war";
  actorAgentID: string;
  actorName: string;
  targetAgentID: string | null;
  targetName: string | null;
  secondaryAgentID?: string | null;
  secondaryName?: string | null;
  message: string;
  publicText?: string;
  actionKind: LegalActionKind;
  actionID: string;
  importance: number;
}

export interface SpectatorCommunicationThread {
  id: string;
  agentIDs: string[];
  title: string;
  latestTurn: number;
  tone: SpectatorEvent["tone"];
  messages: SpectatorEvent[];
}

export interface SpectatorTimelineBucket {
  startTurn: number;
  endTurn: number;
  events: SpectatorEvent[];
}

export interface SpectatorTelemetry {
  version: 1;
  runID: string;
  generatedAt: string;
  agents: SpectatorAgent[];
  relationships: SpectatorRelationship[];
  events: SpectatorEvent[];
  communicationThreads: SpectatorCommunicationThread[];
  timelineBuckets: SpectatorTimelineBucket[];
}

interface BuildAgentSpectatorTelemetryInput {
  runID: string;
  records: AgentDecisionRecord[];
  roster: AgentRunRosterEntry[];
  finalState?: AgentRunFinalState;
}

interface MutableRelationship {
  fromAgentID: string;
  toAgentID: string;
  trust: number;
  distrust: number;
  tension: number;
  allianceState: SpectatorAllianceState;
  tradeGivenGold: number;
  tradeGivenTroops: number;
  attacksSent: number;
  attacksReceived: number;
  betrayals: number;
  lastMajorEventTurn: number | null;
  reasons: string[];
}

export function buildAgentSpectatorTelemetry(
  input: BuildAgentSpectatorTelemetryInput,
): SpectatorTelemetry {
  const agents = buildSpectatorAgents(input);
  const agentByID = new Map(agents.map((agent) => [agent.agentID, agent]));
  const agentByPlayerID = new Map(
    agents.flatMap((agent) =>
      agent.playerID === null ? [] : [[agent.playerID, agent] as const],
    ),
  );
  const relationshipMap = buildRelationshipMap(agents);
  const pendingAllianceRequests = new Set<string>();
  const events: SpectatorEvent[] = [];

  for (const record of [...input.records].sort(recordSort)) {
    const actor = agentByID.get(record.agentID);
    if (actor === undefined) {
      continue;
    }
    const event = eventForRecord({
      record,
      actor,
      agentByPlayerID,
      pendingAllianceRequests,
      relationshipMap,
    });
    if (event !== null) {
      events.push(event);
    }
  }

  addEconomyEvents({
    records: input.records,
    agentByID,
    agentByPlayerID,
    events,
  });
  addEliminationEvents({ input, agents, events });

  const sortedEvents = events.sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  const relationships = [...relationshipMap.values()]
    .map(finalizeRelationship)
    .sort(
      (a, b) =>
        a.fromAgentID.localeCompare(b.fromAgentID) ||
        a.toAgentID.localeCompare(b.toAgentID),
    );

  return {
    version: 1,
    runID: input.runID,
    generatedAt: new Date().toISOString(),
    agents,
    relationships,
    events: sortedEvents,
    communicationThreads: buildCommunicationThreads(sortedEvents),
    timelineBuckets: buildTimelineBuckets(sortedEvents),
  };
}

function buildSpectatorAgents(
  input: BuildAgentSpectatorTelemetryInput,
): SpectatorAgent[] {
  return input.roster.map((entry, index) => {
    const finalPlayer = input.finalState?.players.find(
      (player) =>
        player.agentID === entry.agentID || player.username === entry.username,
    );
    const playerID =
      finalPlayer?.playerID ??
      playerIDFromRecords(input.records, entry.agentID) ??
      null;
    return {
      agentID: entry.agentID,
      playerID,
      username: entry.username,
      profile: entry.profile,
      colorIndex: index,
      finalTilesOwned: finalPlayer?.tilesOwned ?? null,
      finalTroops: finalPlayer?.troops ?? null,
      isAlive: finalPlayer?.isAlive ?? null,
    };
  });
}

function playerIDFromRecords(
  records: readonly AgentDecisionRecord[],
  agentID: string,
): string | null {
  const record = records.find(
    (candidate) =>
      candidate.agentID === agentID &&
      typeof candidate.audit?.after?.playerID === "string",
  );
  return record?.audit?.after?.playerID ?? null;
}

function buildRelationshipMap(
  agents: readonly SpectatorAgent[],
): Map<string, MutableRelationship> {
  const map = new Map<string, MutableRelationship>();
  for (const from of agents) {
    for (const to of agents) {
      if (from.agentID === to.agentID) {
        continue;
      }
      map.set(relationshipKey(from.agentID, to.agentID), {
        fromAgentID: from.agentID,
        toAgentID: to.agentID,
        trust: 50,
        distrust: 10,
        tension: 10,
        allianceState: "none",
        tradeGivenGold: 0,
        tradeGivenTroops: 0,
        attacksSent: 0,
        attacksReceived: 0,
        betrayals: 0,
        lastMajorEventTurn: null,
        reasons: [],
      });
    }
  }
  return map;
}

function eventForRecord(input: {
  record: AgentDecisionRecord;
  actor: SpectatorAgent;
  agentByPlayerID: Map<string, SpectatorAgent>;
  pendingAllianceRequests: Set<string>;
  relationshipMap: Map<string, MutableRelationship>;
}): SpectatorEvent | null {
  const metadata = input.record.chosenActionMetadata ?? {};
  const targetPlayerID = targetPlayerIDForRecord(input.record);
  const recipientPlayerID = recipientPlayerIDForRecord(input.record);
  const primaryPlayerID = recipientPlayerID ?? targetPlayerID;
  const target =
    primaryPlayerID === null
      ? null
      : input.agentByPlayerID.get(primaryPlayerID) ?? null;
  const secondary =
    targetPlayerID !== null && targetPlayerID !== primaryPlayerID
      ? input.agentByPlayerID.get(targetPlayerID) ?? null
      : null;
  const publicText = publicTextForRecord(input.record);
  const eventBase = {
    id: `${input.record.turnNumber}:${input.record.sequence}:${input.record.chosenActionID}`,
    sequence: input.record.sequence,
    turnNumber: input.record.turnNumber,
    actorAgentID: input.actor.agentID,
    actorName: input.actor.username,
    targetAgentID: target?.agentID ?? null,
    targetName:
      target?.username ??
      stringMetadata(metadata, "recipientName") ??
      stringMetadata(metadata, "targetName") ??
      null,
    secondaryAgentID: secondary?.agentID ?? null,
    secondaryName: secondary?.username ?? null,
    publicText: publicText ?? undefined,
    actionKind: input.record.chosenActionKind,
    actionID: input.record.chosenActionID,
  };

  switch (input.record.chosenActionKind) {
    case "spawn":
      return {
        ...eventBase,
        kind: "spawn",
        tone: "info",
        message: `${input.actor.username} enters the match.`,
        importance: 40,
      };
    case "attack":
      if (input.record.chosenActionMetadata?.expansion === true) {
        return {
          ...eventBase,
          kind: "neutral_expansion",
          tone: "info",
          message: `${input.actor.username} expands into neutral land.`,
          importance: input.record.turnNumber <= 1_000 ? 65 : 28,
        };
      }
      if (target !== null) {
        mutatePair(input.relationshipMap, input.actor.agentID, target.agentID, {
          distrust: 25,
          tension: 20,
          attacksSent: 1,
          turnNumber: input.record.turnNumber,
          reason: `Attacked ${target.username}`,
        });
        mutatePair(input.relationshipMap, target.agentID, input.actor.agentID, {
          distrust: 30,
          tension: 25,
          attacksReceived: 1,
          turnNumber: input.record.turnNumber,
          reason: `Was attacked by ${input.actor.username}`,
        });
      }
      return {
        ...eventBase,
        kind: "attack",
        tone: "war",
        message:
          target === null
            ? `${input.actor.username} attacks.`
            : `${input.actor.username} attacks ${target.username}.`,
        importance: 70,
      };
    case "alliance_request": {
      if (target !== null) {
        const reverse = allianceRequestKey(target.agentID, input.actor.agentID);
        const forward = allianceRequestKey(input.actor.agentID, target.agentID);
        input.pendingAllianceRequests.add(forward);
        mutatePair(input.relationshipMap, input.actor.agentID, target.agentID, {
          trust: 12,
          tension: -4,
          allianceState: "requested",
          turnNumber: input.record.turnNumber,
          reason: `Requested alliance with ${target.username}`,
        });
        mutatePair(input.relationshipMap, target.agentID, input.actor.agentID, {
          trust: 6,
          tension: -2,
          allianceState: "requested",
          turnNumber: input.record.turnNumber,
          reason: `${input.actor.username} requested alliance`,
        });
        if (input.pendingAllianceRequests.has(reverse)) {
          mutatePair(input.relationshipMap, input.actor.agentID, target.agentID, {
            trust: 30,
            distrust: -10,
            tension: -10,
            allianceState: "allied",
            turnNumber: input.record.turnNumber,
            reason: `Alliance formed with ${target.username}`,
          });
          mutatePair(input.relationshipMap, target.agentID, input.actor.agentID, {
            trust: 30,
            distrust: -10,
            tension: -10,
            allianceState: "allied",
            turnNumber: input.record.turnNumber,
            reason: `Alliance formed with ${input.actor.username}`,
          });
          return {
            ...eventBase,
            kind: "alliance_formed",
            tone: "pact",
            message: `${input.actor.username} and ${target.username} form an alliance.`,
            importance: 92,
          };
        }
      }
      return {
        ...eventBase,
        kind: "alliance_request",
        tone: "pact",
        message:
          target === null
            ? `${input.actor.username} offers a pact.`
            : `${input.actor.username} offers ${target.username} a pact.`,
        importance: 70,
      };
    }
    case "break_alliance":
      if (target !== null) {
        mutatePair(input.relationshipMap, input.actor.agentID, target.agentID, {
          trust: -60,
          distrust: 60,
          tension: 45,
          betrayals: 1,
          allianceState: "broken",
          turnNumber: input.record.turnNumber,
          reason: `Broke alliance with ${target.username}`,
        });
        mutatePair(input.relationshipMap, target.agentID, input.actor.agentID, {
          trust: -70,
          distrust: 70,
          tension: 55,
          betrayals: 1,
          allianceState: "broken",
          turnNumber: input.record.turnNumber,
          reason: `${input.actor.username} broke the alliance`,
        });
      }
      return {
        ...eventBase,
        kind: "alliance_break",
        tone: "betrayal",
        message:
          target === null
            ? `${input.actor.username} breaks an alliance.`
            : `${input.actor.username} breaks alliance with ${target.username}.`,
        importance: 100,
      };
    case "donate_gold":
    case "donate_troops":
      if (target !== null) {
        mutatePair(input.relationshipMap, input.actor.agentID, target.agentID, {
          trust: 15,
          tension: -4,
          tradeGivenGold:
            input.record.chosenActionKind === "donate_gold"
              ? numberMetadata(metadata, "gold") ?? 1
              : 0,
          tradeGivenTroops:
            input.record.chosenActionKind === "donate_troops"
              ? numberMetadata(metadata, "troops") ?? 1
              : 0,
          turnNumber: input.record.turnNumber,
          reason: `Supported ${target.username}`,
        });
        mutatePair(input.relationshipMap, target.agentID, input.actor.agentID, {
          trust: 10,
          tension: -3,
          turnNumber: input.record.turnNumber,
          reason: `Received support from ${input.actor.username}`,
        });
      }
      return {
        ...eventBase,
        kind: "trade",
        tone: "trade",
        message:
          target === null
            ? `${input.actor.username} sends support.`
            : `${input.actor.username} supports ${target.username}.`,
        importance: 78,
      };
    case "embargo":
    case "embargo_all":
      if (target !== null) {
        mutatePair(input.relationshipMap, input.actor.agentID, target.agentID, {
          distrust: 20,
          tension: 18,
          turnNumber: input.record.turnNumber,
          reason: `Embargoed ${target.username}`,
        });
      }
      return {
        ...eventBase,
        kind: "embargo",
        tone: "threat",
        message:
          target === null
            ? `${input.actor.username} closes trade routes.`
            : `${input.actor.username} embargoes ${target.username}.`,
        importance: input.record.chosenActionKind === "embargo_all" ? 88 : 62,
      };
    case "target_player":
      if (target !== null) {
        mutatePair(input.relationshipMap, input.actor.agentID, target.agentID, {
          distrust: 18,
          tension: 22,
          turnNumber: input.record.turnNumber,
          reason: `Publicly targeted ${target.username}`,
        });
      }
      return {
        ...eventBase,
        kind: "target_call",
        tone: "threat",
        message:
          target === null
            ? `${input.actor.username} marks a target.`
            : `${input.actor.username} marks ${target.username} as target.`,
        importance: 82,
      };
    case "quick_chat":
      applyCommunicationRelationship({
        relationshipMap: input.relationshipMap,
        actor: input.actor,
        target,
        secondary,
        text: publicText,
        turnNumber: input.record.turnNumber,
      });
      return {
        ...eventBase,
        kind: "chat",
        tone: communicationTone(publicText),
        message: publicText ?? `${input.actor.username} sends a message.`,
        importance: communicationImportance(publicText),
      };
    case "emoji":
      applyEmojiRelationship({
        relationshipMap: input.relationshipMap,
        actor: input.actor,
        target,
        turnNumber: input.record.turnNumber,
        context: stringMetadata(metadata, "emojiContext") ?? undefined,
        emojiText: publicText,
      });
      return {
        ...eventBase,
        kind: "emoji",
        tone: emojiTone(stringMetadata(metadata, "emojiContext") ?? undefined),
        message:
          target === null
            ? `${input.actor.username} reacts ${publicText ?? ""}`.trim()
            : `${input.actor.username} reacts to ${target.username} ${publicText ?? ""}`.trim(),
        importance: 44,
      };
    case "nuke":
      if (target !== null) {
        mutatePair(input.relationshipMap, input.actor.agentID, target.agentID, {
          distrust: 80,
          tension: 80,
          turnNumber: input.record.turnNumber,
          reason: `Nuclear threat against ${target.username}`,
        });
      }
      return {
        ...eventBase,
        kind: "nuke",
        tone: "threat",
        message:
          target === null
            ? `${input.actor.username} escalates nuclear pressure.`
            : `${input.actor.username} escalates nuclear pressure against ${target.username}.`,
        importance: 95,
      };
    case "build":
    case "upgrade_structure":
      return {
        ...eventBase,
        kind: "build",
        tone: "info",
        message: `${input.actor.username} develops ${String(metadata.unit ?? "infrastructure")}.`,
        importance: isMajorBuild(metadata) ? 58 : 26,
      };
    case "hold":
      return {
        ...eventBase,
        kind: "hold",
        tone: "info",
        message: `${input.actor.username} waits.`,
        importance: /transport|risky|safety|rebuild/i.test(
          input.record.reason ?? "",
        )
          ? 36
          : 8,
      };
    default:
      return null;
  }
}

function applyCommunicationRelationship(input: {
  relationshipMap: Map<string, MutableRelationship>;
  actor: SpectatorAgent;
  target: SpectatorAgent | null;
  secondary: SpectatorAgent | null;
  text: string | null;
  turnNumber: number;
}) {
  if (input.target !== null) {
    const trustDelta = /pact|alliance|sign early|quiet border|support|shield/i.test(
      input.text ?? "",
    )
      ? 5
      : 1;
    mutatePair(input.relationshipMap, input.actor.agentID, input.target.agentID, {
      trust: trustDelta,
      turnNumber: input.turnNumber,
      reason: `Messaged ${input.target.username}`,
    });
  }
  if (input.secondary !== null) {
    mutatePair(input.relationshipMap, input.actor.agentID, input.secondary.agentID, {
      distrust: /pressure|carve|contain|target/i.test(input.text ?? "") ? 12 : 4,
      tension: /pressure|carve|contain|target/i.test(input.text ?? "") ? 16 : 4,
      turnNumber: input.turnNumber,
      reason: `Discussed pressure on ${input.secondary.username}`,
    });
  }
}

function applyEmojiRelationship(input: {
  relationshipMap: Map<string, MutableRelationship>;
  actor: SpectatorAgent;
  target: SpectatorAgent | null;
  turnNumber: number;
  context?: string;
  emojiText: string | null;
}) {
  if (input.target === null) {
    return;
  }
  if (input.context === "alliance_signal" || input.emojiText === "🤝") {
    mutatePair(input.relationshipMap, input.actor.agentID, input.target.agentID, {
      trust: 4,
      tension: -2,
      turnNumber: input.turnNumber,
      reason: `Signaled cooperation with ${input.target.username}`,
    });
    return;
  }
  if (
    input.context === "pressure_target" ||
    input.context === "anger_under_attack" ||
    input.context === "betrayal_signal"
  ) {
    mutatePair(input.relationshipMap, input.actor.agentID, input.target.agentID, {
      distrust: input.context === "betrayal_signal" ? 18 : 10,
      tension: input.context === "betrayal_signal" ? 18 : 12,
      turnNumber: input.turnNumber,
      reason: `Signaled pressure toward ${input.target.username}`,
    });
  }
}

function mutatePair(
  map: Map<string, MutableRelationship>,
  fromAgentID: string,
  toAgentID: string,
  delta: Partial<{
    trust: number;
    distrust: number;
    tension: number;
    allianceState: SpectatorAllianceState;
    tradeGivenGold: number;
    tradeGivenTroops: number;
    attacksSent: number;
    attacksReceived: number;
    betrayals: number;
    turnNumber: number;
    reason: string;
  }>,
) {
  const relationship = map.get(relationshipKey(fromAgentID, toAgentID));
  if (relationship === undefined) {
    return;
  }
  relationship.trust += delta.trust ?? 0;
  relationship.distrust += delta.distrust ?? 0;
  relationship.tension += delta.tension ?? 0;
  relationship.tradeGivenGold += delta.tradeGivenGold ?? 0;
  relationship.tradeGivenTroops += delta.tradeGivenTroops ?? 0;
  relationship.attacksSent += delta.attacksSent ?? 0;
  relationship.attacksReceived += delta.attacksReceived ?? 0;
  relationship.betrayals += delta.betrayals ?? 0;
  if (delta.allianceState !== undefined) {
    relationship.allianceState = delta.allianceState;
  }
  if (delta.turnNumber !== undefined) {
    relationship.lastMajorEventTurn = delta.turnNumber;
  }
  if (delta.reason !== undefined) {
    relationship.reasons.unshift(delta.reason);
    relationship.reasons = relationship.reasons.slice(0, 5);
  }
}

function finalizeRelationship(
  relationship: MutableRelationship,
): SpectatorRelationship {
  const trust = clampScore(relationship.trust);
  const distrust = clampScore(relationship.distrust);
  const tension = clampScore(relationship.tension);
  const currentLabel: SpectatorRelationshipLabel =
    relationship.allianceState === "allied"
      ? "ally"
      : relationship.allianceState === "broken" || relationship.betrayals > 0
        ? "betrayed"
        : relationship.attacksSent > 0 ||
            distrust >= 55 ||
            tension >= 60
          ? distrust >= 70 || relationship.attacksSent > 1
            ? "rival"
            : "target"
          : trust >= 62
            ? "ally"
            : "neutral";
  return {
    ...relationship,
    trust,
    distrust,
    tension,
    currentLabel,
  };
}

/**
 * P0 fix (2026-08-03): every eliminated agent's synthetic event used to be
 * stamped at the match's own FINAL turn (`lastTurn` below), regardless of
 * when that agent actually died -- see `AgentMatchRecap.ts`'s
 * `compressTerminalEliminations` doc, which already documented this exact
 * gap. The client windows the War Room feed to the viewer's own playhead
 * (`event.turn <= currentTurn`), so a viewer watching anywhere before the
 * literal last turn saw ZERO eliminations, no matter how many agents had
 * already died -- reported live on a 12-player match already down to 7
 * alive with none shown.
 *
 * This pipeline has no sampled turn-by-turn state series to consult (that
 * is `AgentMatchStateDerivations.ts`'s `computeEliminationTimings`, the
 * only genuinely turn-accurate signal, used by `AgentDecisiveMoments.ts` —
 * not available here), so the best available proxy is each agent's own
 * LAST decision record: an eliminated agent stops being asked to decide,
 * so its last record's turn is at most a few turns before its real death —
 * far closer than the match's final turn for anyone eliminated mid-match.
 * Falls back to `lastTurn` only when an agent has no records at all (e.g.
 * failed to ever spawn), preserving today's behavior for that edge case.
 */
function addEliminationEvents(input: {
  input: BuildAgentSpectatorTelemetryInput;
  agents: SpectatorAgent[];
  events: SpectatorEvent[];
}) {
  const lastTurn =
    input.input.finalState?.turnCount ??
    input.input.records.reduce(
      (max, record) => Math.max(max, record.turnNumber),
      0,
    );
  const lastRecordTurnByAgent = lastRecordTurnPerAgent(input.input.records);
  for (const agent of input.agents) {
    if (agent.isAlive === false) {
      const turnNumber = lastRecordTurnByAgent.get(agent.agentID) ?? lastTurn;
      input.events.push({
        id: `${turnNumber}:elimination:${agent.agentID}`,
        sequence: Number.MAX_SAFE_INTEGER - agent.colorIndex,
        turnNumber,
        kind: "elimination",
        tone: "war",
        actorAgentID: agent.agentID,
        actorName: agent.username,
        targetAgentID: null,
        targetName: null,
        message: `${agent.username} is eliminated.`,
        actionKind: "hold",
        actionID: "elimination",
        importance: 90,
      });
    }
  }
}

/**
 * Economy events (PROXYWAR_TUNE_ECONOMY_EVENTS, default OFF — with the flag
 * off this function emits nothing and telemetry is byte-identical to shipped
 * behavior). Derived from the compact economy facts stamped on decision
 * records at decision boundaries (`record.economyFacts`; falls back to the
 * facts embedded in a retained `tacticalAffordances.economyNetwork` block).
 *
 * Emission is TRANSITION-ONLY: per agent the previous facts are compared to
 * the current ones and an event fires only when a tracked state flips
 * (network gains its first operational factory, factories become idle or
 * embargo-blocked, a counterparty trade link appears or drops to zero, a
 * dependency share crosses the threshold). Bounded: at most
 * ECONOMY_EVENT_LIMIT_PER_AGENT economy events per agent per match.
 * publicText is server-authored, one sentence, and keeps physical rail
 * connection, trade eligibility (embargo-only), relationship, and income as
 * distinct facts; trains/ships are never described as agent-controlled.
 */
const ECONOMY_EVENT_LIMIT_PER_AGENT = 12;
const ECONOMY_DEPENDENCY_EVENT_PCT = 50;

const EMPTY_ECONOMY_FACTS: AgentEconomyRecordFacts = {
  factoryCount: 0,
  operationalFactoryCount: 0,
  idleFactoryCount: 0,
  blockedFactoryCount: 0,
  eligibleDestinationCount: 0,
  embargoBlockedDestinationCount: 0,
  counterparties: [],
  bottleneckKind: "none",
};

function addEconomyEvents(input: {
  records: readonly AgentDecisionRecord[];
  agentByID: Map<string, SpectatorAgent>;
  agentByPlayerID: Map<string, SpectatorAgent>;
  events: SpectatorEvent[];
}) {
  if (!economyEventsEnabled()) {
    return;
  }
  const previousByAgent = new Map<string, AgentEconomyRecordFacts>();
  const emittedByAgent = new Map<string, number>();

  for (const record of [...input.records].sort(recordSort)) {
    const actor = input.agentByID.get(record.agentID);
    if (actor === undefined) {
      continue;
    }
    const facts =
      record.economyFacts ??
      (record.tacticalAffordances?.economyNetwork !== undefined
        ? economyFactsFromAffordance(record.tacticalAffordances.economyNetwork)
        : undefined);
    if (facts === undefined) {
      continue;
    }
    const previous = previousByAgent.get(record.agentID) ?? EMPTY_ECONOMY_FACTS;
    previousByAgent.set(record.agentID, facts);

    const emit = (
      kind: SpectatorEventKind,
      tone: SpectatorEvent["tone"],
      importance: number,
      publicText: string,
      target: SpectatorAgent | null,
      dedupeKey: string,
    ) => {
      const emitted = emittedByAgent.get(record.agentID) ?? 0;
      if (emitted >= ECONOMY_EVENT_LIMIT_PER_AGENT) {
        return;
      }
      emittedByAgent.set(record.agentID, emitted + 1);
      input.events.push({
        id: `${record.turnNumber}:${record.sequence}:${dedupeKey}`,
        sequence: record.sequence,
        turnNumber: record.turnNumber,
        kind,
        tone,
        actorAgentID: actor.agentID,
        actorName: actor.username,
        targetAgentID: target?.agentID ?? null,
        targetName: target?.username ?? null,
        message: publicText,
        publicText,
        actionKind: "hold",
        actionID: dedupeKey,
        importance,
      });
    };

    if (
      previous.operationalFactoryCount === 0 &&
      facts.operationalFactoryCount > 0
    ) {
      emit(
        "factory_operational",
        "trade",
        56,
        `${actor.username}'s rail network has an eligible City or Port destination; ${facts.operationalFactoryCount} of ${facts.factoryCount} factories are operational.`,
        null,
        "economy:factory_operational",
      );
    }
    const previousStalled =
      previous.idleFactoryCount + previous.blockedFactoryCount;
    const stalled = facts.idleFactoryCount + facts.blockedFactoryCount;
    if (previousStalled === 0 && stalled > 0) {
      emit(
        "factory_idle",
        "info",
        44,
        facts.blockedFactoryCount > 0
          ? `All City/Port destinations on the rail network of ${facts.blockedFactoryCount} of ${actor.username}'s ${facts.factoryCount} factories are embargo-blocked.`
          : `${facts.idleFactoryCount} of ${actor.username}'s ${facts.factoryCount} factories have no City or Port on their rail network, so no trains can run from them.`,
        null,
        "economy:factory_idle",
      );
    }

    const previousPairs = new Map(
      previous.counterparties.map((pair) => [pair.playerID, pair] as const),
    );
    const currentPairs = new Map(
      facts.counterparties.map((pair) => [pair.playerID, pair] as const),
    );
    const pairIDs = [
      ...new Set([...previousPairs.keys(), ...currentPairs.keys()]),
    ].sort();
    for (const playerID of pairIDs) {
      const before = previousPairs.get(playerID);
      const after = currentPairs.get(playerID);
      const beforeLinks = before?.myEligibleDestinationsTheyOwn ?? 0;
      const afterLinks = after?.myEligibleDestinationsTheyOwn ?? 0;
      const target = input.agentByPlayerID.get(playerID) ?? null;
      const displayName =
        target?.username ?? after?.name ?? before?.name ?? "another player";

      if (beforeLinks === 0 && afterLinks > 0 && after !== undefined) {
        emit(
          "trade_link_established",
          "trade",
          62,
          `${actor.username}'s rail network reaches ${afterLinks} eligible destination${afterLinks === 1 ? "" : "s"} owned by ${displayName}; trade between them is not embargoed.`,
          target,
          `economy:trade_link_established:${playerID}`,
        );
      }
      if (beforeLinks > 0 && afterLinks === 0) {
        emit(
          "trade_severed",
          "threat",
          72,
          tradeSeveredText(actor.username, displayName, before, after),
          target,
          `economy:trade_severed:${playerID}`,
        );
      }
      const beforePct = before?.eligibleDestinationSharePct ?? 0;
      const afterPct = after?.eligibleDestinationSharePct ?? 0;
      if (
        beforePct < ECONOMY_DEPENDENCY_EVENT_PCT &&
        afterPct >= ECONOMY_DEPENDENCY_EVENT_PCT &&
        after !== undefined
      ) {
        emit(
          "economy_dependency",
          "trade",
          64,
          `${displayName} owns ${afterPct}% of the eligible City/Port destinations on ${actor.username}'s rail network (${after.isAllied ? "allied; allied train stops pay more" : "not allied"}).`,
          target,
          `economy:economy_dependency:${playerID}`,
        );
      }
    }
  }
}

function tradeSeveredText(
  actorName: string,
  counterpartyName: string,
  before: AgentEconomyRecordCounterpartyFacts | undefined,
  after: AgentEconomyRecordCounterpartyFacts | undefined,
): string {
  const oursNew =
    (after?.embargoOursOnThem ?? false) &&
    !(before?.embargoOursOnThem ?? false);
  const theirsNew =
    (after?.embargoTheirsOnUs ?? false) &&
    !(before?.embargoTheirsOnUs ?? false);
  if (oursNew && theirsNew) {
    return `Mutual embargoes between ${actorName} and ${counterpartyName} cut ${actorName}'s eligible rail destinations owned by ${counterpartyName} to zero.`;
  }
  if (oursNew) {
    return `${actorName}'s embargo on ${counterpartyName} cut ${actorName}'s eligible rail destinations owned by ${counterpartyName} to zero.`;
  }
  if (theirsNew) {
    return `${counterpartyName}'s embargo on ${actorName} cut ${actorName}'s eligible rail destinations owned by ${counterpartyName} to zero.`;
  }
  return `${actorName} no longer has any eligible rail destination owned by ${counterpartyName}; the connecting stations were destroyed or changed owners.`;
}

function lastRecordTurnPerAgent(
  records: readonly AgentDecisionRecord[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const record of records) {
    const current = result.get(record.agentID);
    if (current === undefined || record.turnNumber > current) {
      result.set(record.agentID, record.turnNumber);
    }
  }
  return result;
}

function buildCommunicationThreads(
  events: readonly SpectatorEvent[],
): SpectatorCommunicationThread[] {
  const map = new Map<string, SpectatorCommunicationThread>();
  for (const event of events) {
    if (
      ![
        "chat",
        "emoji",
        "alliance_request",
        "alliance_formed",
        "alliance_break",
        "trade",
        "target_call",
        "embargo",
        "nuke",
      ].includes(event.kind)
    ) {
      continue;
    }
    const agentIDs = [event.actorAgentID, event.targetAgentID]
      .filter((id): id is string => typeof id === "string")
      .sort();
    if (agentIDs.length < 2) {
      continue;
    }
    const id = agentIDs.join(":");
    const existing = map.get(id);
    const messages = [...(existing?.messages ?? []), event].slice(-16);
    map.set(id, {
      id,
      agentIDs,
      title: `${agentIDs[0]} ↔ ${agentIDs[1]}`,
      latestTurn: event.turnNumber,
      tone: event.tone,
      messages,
    });
  }
  return [...map.values()].sort((a, b) => b.latestTurn - a.latestTurn);
}

function buildTimelineBuckets(
  events: readonly SpectatorEvent[],
): SpectatorTimelineBucket[] {
  const map = new Map<number, SpectatorEvent[]>();
  for (const event of events) {
    if (event.importance < 55) {
      continue;
    }
    const start = Math.floor(event.turnNumber / 1_000) * 1_000;
    map.set(start, [...(map.get(start) ?? []), event]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startTurn, bucketEvents]) => ({
      startTurn,
      endTurn: startTurn + 999,
      events: bucketEvents
        .sort((a, b) => b.importance - a.importance || a.sequence - b.sequence)
        .slice(0, 12),
    }));
}

function recordSort(a: AgentDecisionRecord, b: AgentDecisionRecord): number {
  return a.turnNumber - b.turnNumber || a.sequence - b.sequence;
}

function targetPlayerIDForRecord(record: AgentDecisionRecord): string | null {
  const metadata = record.chosenActionMetadata ?? {};
  if (typeof metadata.targetID === "string") {
    return metadata.targetID;
  }
  if (
    record.intent !== null &&
    "targetID" in record.intent &&
    typeof record.intent.targetID === "string"
  ) {
    return record.intent.targetID;
  }
  return null;
}

function recipientPlayerIDForRecord(record: AgentDecisionRecord): string | null {
  const metadata = record.chosenActionMetadata ?? {};
  if (typeof metadata.recipientID === "string") {
    return metadata.recipientID;
  }
  if (
    record.intent !== null &&
    "recipient" in record.intent &&
    typeof record.intent.recipient === "string"
  ) {
    return record.intent.recipient;
  }
  return null;
}

function publicTextForRecord(record: AgentDecisionRecord): string | null {
  const metadata = record.chosenActionMetadata ?? {};
  if (record.chosenActionKind === "quick_chat") {
    return stringMetadata(metadata, "message") ?? stringMetadata(metadata, "quickChatKey");
  }
  if (record.chosenActionKind === "emoji") {
    return (
      stringMetadata(metadata, "emojiText") ??
      (numberMetadata(metadata, "emoji") !== null
        ? `emoji ${numberMetadata(metadata, "emoji")}`
        : null)
    );
  }
  return null;
}

function communicationTone(text: string | null): SpectatorEvent["tone"] {
  if (/betray|pact is over|knife/i.test(text ?? "")) return "betrayal";
  if (/pact|alliance|sign early|quiet border|support|shield/i.test(text ?? "")) {
    return "pact";
  }
  if (/pressure|carve|target|contain|recover/i.test(text ?? "")) return "threat";
  return "info";
}

function communicationImportance(text: string | null): number {
  const tone = communicationTone(text);
  if (tone === "betrayal") return 92;
  if (tone === "pact") return 68;
  if (tone === "threat") return 66;
  return 42;
}

function emojiTone(context?: string): SpectatorEvent["tone"] {
  if (context === "betrayal_signal") return "betrayal";
  if (context === "alliance_signal") return "pact";
  if (context === "pressure_target" || context === "anger_under_attack") {
    return "threat";
  }
  return "info";
}

function isMajorBuild(metadata: Record<string, string | number | boolean | null>) {
  const unit = stringMetadata(metadata, "unit");
  return (
    unit === "Missile Silo" ||
    unit === "SAM Launcher" ||
    unit === "Defense Post" ||
    unit === "Atom Bomb" ||
    unit === "Hydrogen Bomb" ||
    unit === "MIRV"
  );
}

function allianceRequestKey(fromAgentID: string, toAgentID: string): string {
  return `${fromAgentID}->${toAgentID}`;
}

function relationshipKey(fromAgentID: string, toAgentID: string): string {
  return `${fromAgentID}:${toAgentID}`;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function stringMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function numberMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
