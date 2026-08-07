import { PlayerType, Relation, UnitType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { Intent } from "../../core/Schemas";

export const agentStrategyProfiles = [
  "aggressive",
  "defensive",
  "diplomatic",
  "opportunistic",
] as const;

export type AgentStrategyProfile = (typeof agentStrategyProfiles)[number];

export type AgentBrainType =
  | "rule"
  | "mock-llm"
  | "real-llm"
  | "codex-cli"
  | "external-http"
  | "external-relay"
  | "planner-executor"
  | "llm";

export type AgentRuntimeMode =
  | "local-policy-baseline"
  | "mock-policy-planner"
  | "llm-policy-planner"
  | "llm-action-selector"
  /** Labeled deterministic autopilot that plays out a capped endgame; decisions
   * under this mode are never model play and must never be presented as such. */
  | "autopilot-executor";

export type AgentGamePhase =
  | "lobby"
  | "spawn"
  | "active"
  | "finished"
  | "unknown";

export interface AgentOwnState {
  playerID: string;
  clientID: string | null;
  smallID: number;
  name: string;
  type: PlayerType;
  isAlive: boolean;
  isDisconnected: boolean;
  isTraitor: boolean;
  hasSpawned: boolean;
  troops: number;
  maxTroops?: number;
  troopRatio?: number;
  gold: string;
  tilesOwned: number;
  tileShare?: number;
  borderTiles: number;
  outgoingAttacks: number;
  incomingAttacks: number;
  outgoingAllianceRequests: number;
  incomingAllianceRequests: number;
  /** Team id in Team mode; null in FFA/1v1 (universal-agent: mode awareness). */
  team?: string | null;
  unitCounts?: Partial<Record<UnitType, number>>;
  spawnTile?: TileRef;
}

export interface AgentVisiblePlayer {
  playerID: string;
  clientID: string | null;
  smallID: number;
  name: string;
  type: PlayerType;
  isAlive: boolean;
  isDisconnected: boolean;
  hasSpawned: boolean;
  troops: number;
  maxTroops?: number;
  troopRatio?: number;
  gold: string;
  tilesOwned: number;
  tileShare?: number;
  sharesBorder: boolean;
  isAllied: boolean;
  isFriendly: boolean;
  relation: Relation;
  canAttack: boolean;
  attackLegalReason?: string;
  attackBlocker?: string;
  canRequestAlliance: boolean;
  canDonateGold: boolean;
  canDonateTroops: boolean;
  canEmbargo: boolean;
  canStopEmbargo?: boolean;
  canTarget?: boolean;
  canBreakAlliance?: boolean;
  canExtendAlliance?: boolean;
  canRejectAlliance?: boolean;
  hasEmbargoAgainst: boolean;
  outgoingAttack: boolean;
  incomingAttack: boolean;
  hasOutgoingAllianceRequest: boolean;
  hasIncomingAllianceRequest: boolean;
  /** This rival has ANY live incoming attack (from anyone — not agent-relative
   *  like `incomingAttack`). The coalition "leader's victim" support signal.
   *  Omitted when false (additive, wire-compatible). */
  underSiege?: boolean;
  allianceExpiresAt?: number;
  allianceInExtensionWindow?: boolean;
  relativeTroopRatio?: number;
  spawnDistance?: number;
  /** Player IDs of OTHER visible players this rival is allied with (the rival-rival
   *  coalition edge — excludes the agent itself, whose alliance is `isAllied`). Lets the
   *  Commander see a coalition / 3v1 forming instead of only its own alliances. Omitted
   *  when this rival has no alliances with other visible players. */
  alliedWithVisibleIds?: string[];
  /** Team id in Team mode; null in FFA/1v1. */
  team?: string | null;
  /** True if this player is on the agent's own team (never betray/attack a teammate). */
  isTeammate?: boolean;
  /**
   * City/Factory/Port counts for this rival (PROXYWAR_TUNE_ECONOMY_OBSERVATION;
   * absent when the flag is off — additive, wire-compatible).
   */
  unitCounts?: Partial<Record<UnitType, number>>;
  /** Rival traitor state (PROXYWAR_TUNE_ECONOMY_OBSERVATION; absent when off). */
  isTraitor?: boolean;
}

export interface AgentAttackOption {
  attackID: string;
  targetID: string | null;
  targetName: string;
  troops: number;
  retreating: boolean;
  sourceTile: TileRef | null;
  borderSize: number;
}

export interface AgentCombatState {
  ownTroops: number | null;
  maxTroops?: number | null;
  troopRatio?: number | null;
  borderedPlayerIDs: string[];
  attackablePlayerIDs: string[];
  canExpandIntoNeutral: boolean;
  neutralExpansionLegalReason: string | null;
  incomingAttackPlayerIDs: string[];
  outgoingAttackPlayerIDs: string[];
  outgoingAttacks?: AgentAttackOption[];
  incomingAttacks?: AgentAttackOption[];
  weakestAttackableTargetID: string | null;
  strongestAttackableTargetID: string | null;
  blockerNotes: string[];
}

export type AgentBuildRole = "economic" | "defensive" | "infrastructure";

export interface AgentBuildOption {
  unit: UnitType;
  role: AgentBuildRole;
  targetTile: TileRef;
  buildTile: TileRef;
  cost: string;
  legalReason: string;
  isBorderBuild?: boolean;
  borderDistance?: number;
  hostileBorderDistance?: number | null;
  nearbyEnemyCount?: number;
  nearbyAllyCount?: number;
  nearbyIncomingAttack?: boolean;
  ownedNeighborCount?: number;
  frontierValue?: number;
  economicValue?: number;
  defensiveValue?: number;
  buildPlacementReason?: string;
  nukeTargetID?: string | null;
  nukeTargetName?: string | null;
  nukeTargetTiles?: number | null;
  nukeTargetTileShare?: number | null;
  nukeTargetStructureUnit?: string | null;
  nukeTargetStructureLevel?: number | null;
  nukeTargetStructurePriority?: number | null;
  nukeTargetStructureDensity?: number | null;
  nukeTargetSamCoverage?: number | null;
  nukeTargetPriority?: number | null;
}

export interface AgentUpgradeOption {
  unitID: number;
  unit: UnitType;
  tile: TileRef;
  level: number;
  cost: string;
  legalReason: string;
}

export interface AgentDeleteUnitOption {
  unitID: number;
  unit: UnitType;
  tile: TileRef;
  level: number;
  legalReason: string;
}

export interface AgentBoatOption {
  targetTile: TileRef;
  sourceTile: TileRef;
  targetID: string | null;
  targetName: string;
  troops: number;
  legalReason: string;
}

export interface AgentBoatRetreatOption {
  unitID: number;
  tile: TileRef;
  targetTile: TileRef | null;
  troops: number;
  legalReason: string;
}

export interface AgentTransportState {
  unitID: number;
  status: "en_route" | "returning";
  tile: TileRef;
  targetTile: TileRef | null;
  targetID: string | null;
  targetName: string | null;
  troops: number;
  /** Manhattan distance only: a deterministic progress hint, not route length or ETA. */
  remainingManhattanDistance: number | null;
}

export interface AgentTransportLaunchState {
  activeTransportCount: number;
  maximumTransportCount: number;
  launchSlotsRemaining: number;
  blocker:
    | "transport_disabled"
    | "transport_cap_reached"
    | "no_reachable_target"
    | null;
}

export interface AgentWarshipMoveOption {
  unitIDs: number[];
  targetTile: TileRef;
  legalReason: string;
}

export interface AgentAllianceOption {
  playerID: string;
  playerName: string;
  action: "reject" | "extend" | "break";
  legalReason: string;
}

export interface AgentTargetOption {
  targetID: string;
  targetName: string;
  legalReason: string;
}

export interface AgentEmojiOption {
  recipientID: string;
  recipientName: string;
  emoji: number;
  emojiText?: string;
  emojiContext?: string;
  legalReason: string;
}

export interface AgentQuickChatOption {
  recipientID: string;
  recipientName: string;
  quickChatKey: string;
  message?: string;
  targetID?: string;
  targetName?: string;
  nuclearThreat?: boolean;
  legalReason: string;
}

export interface AgentSupportOption {
  recipientID: string;
  recipientName: string;
  canDonateGold: boolean;
  canDonateTroops: boolean;
  suggestedGold: number | null;
  suggestedTroops: number | null;
  legalReasons: string[];
}

export interface AgentEmbargoOption {
  targetID: string;
  targetName: string;
  action: "start" | "stop";
  legalReason: string;
}

export interface AgentNonCombatState {
  buildOptions: AgentBuildOption[];
  upgradeOptions?: AgentUpgradeOption[];
  deleteUnitOptions?: AgentDeleteUnitOption[];
  boatOptions?: AgentBoatOption[];
  transportStates?: AgentTransportState[];
  transportLaunch?: AgentTransportLaunchState;
  /** @deprecated Transport recall is no longer offered to agents. Retained for
   * compatibility with older observations and internal policy fixtures. */
  boatRetreatOptions?: AgentBoatRetreatOption[];
  warshipMoveOptions?: AgentWarshipMoveOption[];
  allianceOptions?: AgentAllianceOption[];
  targetOptions?: AgentTargetOption[];
  emojiOptions?: AgentEmojiOption[];
  quickChatOptions?: AgentQuickChatOption[];
  supportOptions: AgentSupportOption[];
  embargoOptions: AgentEmbargoOption[];
  canEmbargoAll?: boolean;
  blockerNotes: string[];
}

export type AgentHomeDangerLevel = "low" | "medium" | "high";

export interface AgentTransportTroopBankingAffordance {
  tacticID: "transport_troop_banking";
  nearCap: boolean;
  recommended: boolean;
  ownTroops: number | null;
  maxTroops: number | null;
  troopRatio: number | null;
  activeTransportCount: number;
  activeTransportTroops: number;
  largestActiveTransportTroops: number;
  activeBankRatio: number | null;
  continuationReady: boolean;
  availableBoatLaunchActionCount: number;
  availableBoatLaunchTroops: number[];
  largestAvailableBoatLaunchTroops: number;
  incomingThreatTroops: number;
  incomingThreatRatio: number | null;
  homeDanger: AgentHomeDangerLevel;
  effectiveFutureTroops: number | null;
  effectiveFutureTroopRatio: number | null;
  reasons: string[];
}

export interface AgentOpeningExpansionTempoAffordance {
  tacticID: "opening_expansion_tempo";
  openingWindow: boolean;
  recommended: boolean;
  turnNumber: number;
  ownTiles: number | null;
  ownTileShare: number | null;
  expectedTileShare: number | null;
  leaderTileShare: number | null;
  leaderTileShareGap: number | null;
  neutralExpansionAvailable: boolean;
  neutralLandExpansionActionCount: number;
  neutralBoatExpansionActionCount: number;
  largestExpansionTroopPercent: number | null;
  economicBuildActionCount: number;
  incomingThreatRatio: number | null;
  homeDanger: AgentHomeDangerLevel;
  behindExpectedTempo: boolean;
  leaderGapDanger: boolean;
  reasons: string[];
}

export interface AgentFrontierConversionTimingAffordance {
  tacticID: "frontier_conversion_timing";
  recommended: boolean;
  strategicWindow: boolean;
  executorReady: boolean;
  turnNumber: number;
  ownTiles: number | null;
  ownTileShare: number | null;
  troopRatio: number | null;
  enoughLandBase: boolean;
  recentExpansionCount: number;
  neutralExpansionAvailable: boolean;
  neutralExpansionActionCount: number;
  hostileAttackActionCount: number;
  favorableHostileAttackActionCount: number;
  executorReadyHostileAttackActionCount: number;
  bestTargetID: string | null;
  bestTargetName: string | null;
  bestTargetRelativeTroopRatio: number | null;
  bestTargetTileShare: number | null;
  bestAttackTroopPercent: number | null;
  bestExecutorReadyTargetID: string | null;
  bestExecutorReadyTargetName: string | null;
  bestExecutorReadyRelativeTroopRatio: number | null;
  bestExecutorReadyTileShare: number | null;
  bestExecutorReadyAttackTroopPercent: number | null;
  leaderTileShare: number | null;
  leaderTileShareGap: number | null;
  incomingThreatRatio: number | null;
  homeDanger: AgentHomeDangerLevel;
  reasons: string[];
}

export interface AgentFrontierFinishPressureAffordance {
  tacticID: "frontier_finish_pressure";
  recommended: boolean;
  turnNumber: number;
  ownTileShare: number | null;
  troopRatio: number | null;
  homeDanger: AgentHomeDangerLevel;
  activeTargetID: string | null;
  activeTargetName: string | null;
  recentTargetAttackCount: number;
  recentLowCommitmentAttackCount: number;
  repeatedLowCommitmentProbe: boolean;
  finishingAttackActionCount: number;
  decisiveAttackActionCount: number;
  bestTargetID: string | null;
  bestTargetName: string | null;
  bestTargetRelativeTroopRatio: number | null;
  bestTargetTileShare: number | null;
  bestTargetTroops: number | null;
  bestAttackTroopPercent: number | null;
  bestAttackID: string | null;
  reasons: string[];
}

export interface AgentEconomyCadenceAffordance {
  tacticID: "economy_cadence";
  recommended: boolean;
  turnNumber: number;
  ownTiles: number | null;
  ownTileShare: number | null;
  troopRatio: number | null;
  homeDanger: AgentHomeDangerLevel;
  recentExpansionCount: number;
  recentBuildCount: number;
  cityCount: number;
  factoryCount: number;
  portCount: number;
  coreEconomyCount: number;
  firstCityMissing: boolean;
  firstFactoryMissing: boolean;
  firstPortMissing: boolean;
  enoughLandBase: boolean;
  economyBuildActionCount: number;
  safeEconomyBuildActionCount: number;
  cityBuildActionCount: number;
  factoryBuildActionCount: number;
  portBuildActionCount: number;
  bestBuildID: string | null;
  bestBuildUnit: string | null;
  bestBuildEconomicValue: number | null;
  reasons: string[];
}

export interface AgentNavalControlAffordance {
  tacticID: "naval_control";
  recommended: boolean;
  turnNumber: number;
  ownTileShare: number | null;
  troopRatio: number | null;
  homeDanger: AgentHomeDangerLevel;
  portCount: number;
  warshipCount: number;
  activeTransportCount: number;
  activeTransportTroops: number;
  boatLaunchActionCount: number;
  neutralBoatActionCount: number;
  navalInvasionActionCount: number;
  warshipBuildActionCount: number;
  warshipMoveActionCount: number;
  safeNavalActionCount: number;
  bestNavalActionID: string | null;
  bestNavalActionKind: LegalActionKind | null;
  bestNavalTargetID: string | null;
  bestNavalTargetName: string | null;
  bestNavalTroopPercent: number | null;
  reasons: string[];
}

export interface AgentLateGameStrikeTargetingAffordance {
  tacticID: "late_game_strike_targeting";
  recommended: boolean;
  turnNumber: number;
  ownTileShare: number | null;
  troopRatio: number | null;
  homeDanger: AgentHomeDangerLevel;
  legalStrikeActionCount: number;
  highValueStrikeActionCount: number;
  siloTargetActionCount: number;
  samTargetActionCount: number;
  economyTargetActionCount: number;
  coveredNonSamTargetActionCount: number;
  recentNukeCount: number;
  bestStrikeActionID: string | null;
  bestStrikeWeapon: string | null;
  bestStrikeTargetID: string | null;
  bestStrikeTargetName: string | null;
  bestStrikeTargetTileShare: number | null;
  bestStrikeTargetStructureUnit: string | null;
  bestStrikeTargetStructurePriority: number | null;
  bestStrikeTargetSamCoverage: number | null;
  bestStrikeNuclearTargetPriority: number | null;
  bestStrikeScore: number | null;
  reasons: string[];
}

export type AgentPersonalityDiplomacyMode =
  | "aggressive_pressure"
  | "opportunistic_pressure"
  | "defensive_alliance"
  | "diplomatic_support"
  | "showmanship";

export interface AgentPersonalityDiplomacyPressureAffordance {
  tacticID: "personality_diplomacy_pressure";
  recommended: boolean;
  turnNumber: number;
  profile: AgentStrategyProfile;
  homeDanger: AgentHomeDangerLevel;
  recentSocialActionCount: number;
  recentPressureActionCount: number;
  socialActionCount: number;
  pressureActionCount: number;
  allianceActionCount: number;
  supportActionCount: number;
  communicationActionCount: number;
  targetActionCount: number;
  embargoActionCount: number;
  bestSocialActionID: string | null;
  bestSocialActionKind: LegalActionKind | null;
  bestSocialTargetID: string | null;
  bestSocialTargetName: string | null;
  bestSocialScore: number | null;
  personalityMode: AgentPersonalityDiplomacyMode | null;
  reasons: string[];
}

export interface AgentSurvivalAllianceAffordance {
  tacticID: "survival_alliance";
  recommended: boolean;
  turnNumber: number;
  ownTileShare: number;
  aliveRivalCount: number;
  hasAlliance: boolean;
  bestAllyTargetID: string | null;
  bestAllyName: string | null;
  reason: string;
}

export interface AgentBackstabAllyAffordance {
  tacticID: "backstab_ally";
  recommended: boolean;
  turnNumber: number;
  backstabTargetID: string | null;
  backstabTargetName: string | null;
  ownTileShare: number;
  reason: string;
}

/**
 * Economy snapshot types (PROXYWAR_TUNE_ECONOMY_OBSERVATION, default OFF).
 * Computed by `AgentEconomyNetwork.ts` from live core state (RailNetwork /
 * StationManager / Cluster / Player.canTrade / stats gold indices) — pure
 * reads, integer/bigint math, no pathfinding, deterministic for a given
 * snapshot. Vocabulary discipline: physical rail connection, trade
 * eligibility (embargo-only), relationship, and realized income are separate
 * facts and are never merged.
 */
export type AgentEconomyFactoryStatus =
  | "operational"
  | "idle_no_destination"
  | "blocked_by_embargo";

export type AgentEconomyBottleneckKind =
  | "none"
  | "missing_trade_destination"
  | "insufficient_factory_capacity"
  | "population_capacity"
  | "foreign_dependency"
  | "embargo_disruption"
  | "insufficient_gold"
  | "unsafe_investment_window"
  | "unknown";

/**
 * Cumulative gold earned per verified stats source (the six GOLD_INDEX_*
 * buckets that already exist — deliberately never merged into one number).
 * Serialized bigints, matching the observation's existing gold fields.
 */
export interface AgentEconomyIncomeBySource {
  work: string;
  war: string;
  tradeShips: string;
  capturedTradeShips: string;
  trainSelf: string;
  trainExternal: string;
}

export interface AgentEconomyEmbargoBlock {
  playerID: string;
  name: string;
  /** Whose embargo blocks trade: ours on them, theirs on us, or both. */
  direction: "ours" | "theirs" | "mutual";
  blockedDestinationCount: number;
}

export interface AgentEconomyClusterSummary {
  /**
   * Derived stable key: min TrainStation.id over the cluster's stations
   * (clusters themselves carry no stable identity in core; station ids are
   * stable monotonic ints). Recomputed fresh each decision step.
   */
  clusterKey: number;
  stationCount: number;
  ownStations: { city: number; factory: number; port: number };
  foreignStations: { city: number; factory: number; port: number };
  /** City/Port stations this agent's trains may stop at (embargo-only gate). */
  eligibleDestinationCount: number;
  embargoBlockedDestinationCount: number;
  blockedBy: AgentEconomyEmbargoBlock[];
}

export interface AgentEconomyFactorySummary {
  unitID: number;
  tile: TileRef;
  level: number;
  /** Null when the factory is not part of any rail cluster. */
  clusterKey: number | null;
  status: AgentEconomyFactoryStatus;
}

export interface AgentEconomyCounterpartySummary {
  playerID: string;
  name: string;
  isAllied: boolean;
  sharedClusterKeys: number[];
  /** Their eligible City/Port stations on clusters touching this agent. */
  myEligibleDestinationsTheyOwn: number;
  /** This agent's eligible City/Port stations on shared clusters. */
  theirEligibleDestinationsIOwn: number;
  /**
   * Integer percent (0-100) of ALL this agent's eligible destinations owned
   * by this counterparty — the structural dependency. Null when the agent has
   * no eligible destinations at all.
   */
  eligibleDestinationSharePct: number | null;
  /**
   * Both sides own >=1 Port and trade is not embargoed. Eligibility only —
   * says nothing about ocean reachability (no pathfinding in this analyzer).
   */
  portTradeEligible: boolean;
  embargoOursOnThem: boolean;
  embargoTheirsOnUs: boolean;
  /** Verified payout implication: per-stop train gold at the current relation. */
  trainStopGoldCurrent: string;
  /** Per-stop train gold if allied (verified: ally 35k > neutral 25k). */
  trainStopGoldIfAllied: string;
}

export interface AgentEconomyBottleneck {
  kind: AgentEconomyBottleneckKind;
  /** Server-authored one-sentence evidence with concrete numbers. */
  evidence: string;
}

/**
 * Compact UNCAPPED per-counterparty trade-link entry. One entry for every
 * counterparty that either owns >=1 eligible destination for this agent
 * (`links` > 0) or has an embargo edge with it (so severed-link attribution
 * stays exact). Bounded by alive seats, not by the counterparty reporting cap
 * — spectator pair-transition detection reads ONLY this list, so cap-driven
 * churn in the rich `counterparties` list can never fabricate
 * trade_severed / trade_link_established events.
 */
export interface AgentEconomyRecordPairLink {
  playerID: string;
  name: string;
  /** Their eligible City/Port stations on clusters touching this agent. */
  links: number;
  embargoOursOnThem: boolean;
  embargoTheirsOnUs: boolean;
}

export interface AgentEconomyObservation {
  incomeBySource: AgentEconomyIncomeBySource;
  /** Total rail clusters touching the agent (before the reporting cap). */
  clusterCount: number;
  /** Capped at 6, sorted by clusterKey ascending. */
  clusters: AgentEconomyClusterSummary[];
  factoryCount: number;
  /** Capped at 12, sorted by unitID ascending; counts below stay exact. */
  factories: AgentEconomyFactorySummary[];
  factoryStatusCounts: {
    operational: number;
    idleNoDestination: number;
    blockedByEmbargo: number;
  };
  /** Deduped across touching clusters (clusters are disjoint by construction). */
  eligibleDestinationCount: number;
  embargoBlockedDestinationCount: number;
  /** Total structural counterparties (before the reporting cap). */
  counterpartyCount: number;
  /** Capped at 8, sorted by playerID ascending. */
  counterparties: AgentEconomyCounterpartySummary[];
  /** Uncapped trade-link list (bounded by seats), sorted by playerID. */
  pairLinks: AgentEconomyRecordPairLink[];
  bottleneck: AgentEconomyBottleneck;
}

/**
 * Compact per-decision economy facts stamped onto decision records when
 * PROXYWAR_TUNE_ECONOMY_EVENTS is on (the permissive decisions.jsonl surface,
 * never results.json). Spectator telemetry derives transition-only economy
 * events from consecutive records' facts.
 */
export interface AgentEconomyRecordCounterpartyFacts {
  playerID: string;
  name: string;
  isAllied: boolean;
  myEligibleDestinationsTheyOwn: number;
  eligibleDestinationSharePct: number | null;
  embargoOursOnThem: boolean;
  embargoTheirsOnUs: boolean;
}

export interface AgentEconomyRecordFacts {
  factoryCount: number;
  operationalFactoryCount: number;
  idleFactoryCount: number;
  blockedFactoryCount: number;
  eligibleDestinationCount: number;
  embargoBlockedDestinationCount: number;
  counterparties: AgentEconomyRecordCounterpartyFacts[];
  /**
   * Uncapped trade-link list — the ONLY source for pair-transition spectator
   * events (trade_link_established / trade_severed). Optional solely for
   * tolerance of records stamped before this field existed; those records
   * produce no pair events rather than cap-eviction false positives.
   */
  pairLinks?: AgentEconomyRecordPairLink[];
  bottleneckKind: AgentEconomyBottleneckKind;
}

export interface AgentEconomyNetworkAffordance {
  tacticID: "economy_network";
  recommended: boolean;
  turnNumber: number;
  factoryCount: number;
  operationalFactoryCount: number;
  idleFactoryCount: number;
  blockedFactoryCount: number;
  clusterCount: number;
  eligibleDestinationCount: number;
  embargoBlockedDestinationCount: number;
  trainSelfIncome: string;
  trainExternalIncome: string;
  tradeShipIncome: string;
  topCounterpartyID: string | null;
  topCounterpartyName: string | null;
  topCounterpartyDependencyPct: number | null;
  topCounterpartyAllied: boolean | null;
  counterparties: AgentEconomyRecordCounterpartyFacts[];
  /** Uncapped trade-link list (see AgentEconomyRecordPairLink). */
  pairLinks: AgentEconomyRecordPairLink[];
  bottleneckKind: AgentEconomyBottleneckKind;
  bottleneckEvidence: string;
  reasons: string[];
}

export interface AgentTacticalAffordances {
  transportTroopBanking: AgentTransportTroopBankingAffordance;
  openingExpansionTempo?: AgentOpeningExpansionTempoAffordance;
  frontierConversionTiming?: AgentFrontierConversionTimingAffordance;
  frontierFinishPressure?: AgentFrontierFinishPressureAffordance;
  economyCadence?: AgentEconomyCadenceAffordance;
  navalControl?: AgentNavalControlAffordance;
  lateGameStrikeTargeting?: AgentLateGameStrikeTargetingAffordance;
  personalityDiplomacyPressure?: AgentPersonalityDiplomacyPressureAffordance;
  survivalAlliance?: AgentSurvivalAllianceAffordance;
  backstabAlly?: AgentBackstabAllyAffordance;
  /** Present only when the observation carries the flag-gated economy block. */
  economyNetwork?: AgentEconomyNetworkAffordance;
  notes: string[];
}

export type AgentStrategicPriority =
  | "spawn"
  | "expand"
  | "attack"
  | "build_economy"
  | "build_defense"
  | "ally"
  | "support"
  | "pressure"
  | "naval"
  | "nuclear"
  | "hold";

export interface AgentStrategicScores {
  expansion: number;
  economy: number;
  defense: number;
  offense: number;
  diplomacy: number;
  naval?: number;
  nuclear?: number;
  threat: number;
  idleTroops: number;
}

export interface AgentStrategicState {
  priority: AgentStrategicPriority;
  urgency: "low" | "medium" | "high";
  summary: string;
  scores: AgentStrategicScores;
  recommendedActionKinds: LegalActionKind[];
  targetPlayerIDs: string[];
  notes: string[];
}

export type AgentObjectiveKind =
  | "choose_spawn"
  | "expand_territory"
  | "secure_economy"
  | "fortify_border"
  | "pressure_rival"
  | "build_alliance"
  | "survive";

export interface AgentObjectiveProgress {
  recentDecisionCount: number;
  alignedRecentDecisionCount: number;
  consecutiveAlignedDecisionCount: number;
}

export interface AgentObjectiveState {
  objectiveID: string;
  kind: AgentObjectiveKind;
  label: string;
  status: "active" | "blocked" | "completed";
  createdTurn: number;
  updatedTurn: number;
  preferredActionKinds: LegalActionKind[];
  targetPlayerID?: string | null;
  targetPlayerName?: string;
  progress: AgentObjectiveProgress;
  summary: string;
  notes: string[];
}

export interface RecentAgentDecision {
  sequence: number;
  actionID: string;
  actionKind: LegalActionKind;
  reason: string;
  accepted: boolean;
  ownTiles?: number;
  ownTroops?: number;
  spawnPressureScore?: number;
  spawnSafetyScore?: number;
  spawnOpportunityScore?: number;
  spawnLocalLandScore?: number;
  targetID?: string | null;
  targetName?: string;
  unit?: string;
  expansion?: boolean;
}

export type AgentCommunicationIntent =
  | "coordinate_attack"
  | "request_support"
  | "propose_alliance"
  | "warn_threat"
  | "acknowledge"
  | "taunt"
  | "unknown";

export interface AgentCommunicationSignal {
  sequence: number;
  turnNumber: number;
  senderAgentID: string;
  senderPlayerID?: string | null;
  senderName: string;
  senderProfile: AgentStrategyProfile;
  actionKind: "quick_chat" | "emoji" | "target_player" | "alliance_request";
  intent: AgentCommunicationIntent;
  recipientID?: string | null;
  recipientName?: string | null;
  targetID?: string | null;
  targetName?: string | null;
  quickChatKey?: string | null;
  message?: string | null;
  emoji?: number | null;
  emojiText?: string | null;
  directToAgent: boolean;
}

export interface AgentMemory {
  recentActions: RecentAgentDecision[];
  recentActionCountsByKind: Partial<Record<LegalActionKind, number>>;
  recentNonHoldCount: number;
  recentExpansionCount: number;
  recentBuildCount: number;
  recentHoldCount?: number;
  turnsSinceLastProductiveAction?: number;
  repeatedActionKind: LegalActionKind | null;
  repeatedActionCount: number;
  avoidActionIDs: string[];
  summary: string;
  notes: string[];
}

/**
 * A persistent, per-game belief about one rival, accumulated across decisions
 * (the agent's "theory of mind" substrate). Derived deterministically from the
 * ordered observation stream — no wall-clock, no RNG — so replays stay reproducible.
 */
export interface AgentOpponentModelEntry {
  playerID: string;
  name: string;
  tileShare: number;
  /** myTroops/theirTroops style ratio: >1 means I am stronger than them. */
  relativeTroopRatio?: number;
  relation: Relation;
  isAllied: boolean;
  /** Smoothed territory trend since first seen. */
  momentum: "rising" | "falling" | "flat";
  /** Distinct times this rival has launched an attack on me this game. */
  attacksOnMe: number;
  /** Was an ally of mine, then turned hostile / attacked me. */
  betrayedMe: boolean;
  isLeader: boolean;
  /** This rival's most recent communication intent (to me or broadcast), if any. */
  lastSignal: AgentCommunicationIntent | null;
  threat: "high" | "medium" | "low";
  /** 0..1 estimate of how trustworthy this rival is as an ally. */
  trust: number;
  /** Deterministic theory-of-mind guess at what this rival will do next. */
  predictedNextAction: string;
}

export interface AgentObservation {
  agentID: string;
  clientID: string | null;
  username: string;
  profile: AgentStrategyProfile;
  gameID: string;
  /** Game configuration (universal-agent: adapt to mode, not a fixed 4-FFA assumption). */
  gameMode?: "FFA" | "Team";
  /** Count of currently-alive players (any N), so the agent scales from 1v1 to many-player. */
  alivePlayerCount?: number;
  phase: AgentGamePhase;
  turnNumber: number;
  tick: number | null;
  ownState: AgentOwnState | null;
  visiblePlayers: AgentVisiblePlayer[];
  combat: AgentCombatState;
  nonCombat: AgentNonCombatState;
  strategic: AgentStrategicState;
  memory: AgentMemory;
  tacticalAffordances?: AgentTacticalAffordances;
  objective: AgentObjectiveState | null;
  recentDecisions: RecentAgentDecision[];
  recentCommunications?: AgentCommunicationSignal[];
  /** Persistent per-rival belief state (theory of mind). Populated by the brain. */
  opponentModel?: AgentOpponentModelEntry[];
  /**
   * Economy snapshot (PROXYWAR_TUNE_ECONOMY_OBSERVATION, default OFF; absent
   * when the flag is off — observations are then byte-identical to shipped
   * behavior). Built by `AgentEconomyNetwork.ts`.
   */
  economy?: AgentEconomyObservation;
  endgame?: {
    winner: string | null;
    leaderID: string | null;
    leaderName: string | null;
    leaderTileShare: number;
    ownTileShare: number;
    turnsToTimer: number | null;
  };
  notes: string[];
}

/**
 * Current observations use `transportStates`. The fallback keeps retained
 * observations and older policy fixtures readable without emitting the
 * obsolete recall-option field in new observations.
 */
export function observedTransportStates(
  observation: AgentObservation,
): readonly (AgentTransportState | AgentBoatRetreatOption)[] {
  return (
    observation.nonCombat.boatRetreatOptions ??
    observation.nonCombat.transportStates ??
    []
  );
}

export type LegalActionKind =
  | "spawn"
  | "hold"
  | "attack"
  | "retreat"
  | "boat"
  | "boat_retreat"
  | "alliance_request"
  | "alliance_reject"
  | "alliance_extend"
  | "break_alliance"
  | "target_player"
  | "emoji"
  | "quick_chat"
  | "build"
  | "upgrade_structure"
  | "delete_unit"
  | "move_warship"
  | "warship"
  | "nuke"
  | "donate_gold"
  | "donate_troops"
  | "embargo"
  | "embargo_stop"
  | "embargo_all";

export const legalActionKinds = [
  "spawn",
  "hold",
  "attack",
  "retreat",
  "boat",
  "boat_retreat",
  "alliance_request",
  "alliance_reject",
  "alliance_extend",
  "break_alliance",
  "target_player",
  "emoji",
  "quick_chat",
  "build",
  "upgrade_structure",
  "delete_unit",
  "move_warship",
  "warship",
  "nuke",
  "donate_gold",
  "donate_troops",
  "embargo",
  "embargo_stop",
  "embargo_all",
] as const satisfies readonly LegalActionKind[];

export interface LegalActionRisk {
  level: "none" | "low" | "medium" | "high";
  score?: number;
  notes?: string[];
}

export interface LegalAction {
  id: string;
  kind: LegalActionKind;
  label: string;
  intent: Intent | null;
  risk: LegalActionRisk;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AgentDecision {
  actionID: string;
  actionIDs?: string[];
  reason: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AgentBrainInput {
  observation: AgentObservation;
  legalActions: LegalAction[];
}

export type AgentBrainDecision = AgentDecision | Promise<AgentDecision>;

export interface AgentBrain {
  readonly brainType?: AgentBrainType;
  decide(input: AgentBrainInput): AgentBrainDecision;
}

export interface AgentActionResult {
  accepted: boolean;
  reason: string;
  submittedIntent: Intent | null;
}

export type AgentActionAuditStatus =
  | "confirmed"
  | "unknown"
  | "failed"
  | "not_applicable";

export interface AgentActionAuditSnapshot {
  tick: number | null;
  playerID: string | null;
  isAlive: boolean | null;
  hasSpawned: boolean | null;
  tilesOwned: number | null;
  troops: number | null;
  gold: string | null;
  unitCounts: Partial<Record<UnitType, number>>;
  unitLevels?: Record<string, number>;
  unitTiles?: Record<string, number>;
  outgoingAttackTargetIDs: string[];
  outgoingAttackIDs?: string[];
  outgoingAllianceRequestRecipientIDs: string[];
  outgoingEmbargoTargetIDs: string[];
  targetPlayerIDs?: string[];
  transportRetreatingUnitIDs?: number[];
}

export interface AgentActionAudit {
  auditStatus: AgentActionAuditStatus;
  auditReason: string;
  before?: AgentActionAuditSnapshot | null;
  after?: AgentActionAuditSnapshot | null;
  targetBefore?: AgentActionAuditSnapshot | null;
  targetAfter?: AgentActionAuditSnapshot | null;
}

export interface AgentDecisionRecord {
  sequence: number;
  gameID: string;
  agentID: string;
  clientID: string | null;
  username: string;
  profile: AgentStrategyProfile;
  brainType: AgentBrainType;
  turnNumber: number;
  decidedAt: number;
  decisionLatencyMs: number;
  observationSummary: string;
  strategicPriority?: AgentStrategicPriority;
  strategicUrgency?: AgentStrategicState["urgency"];
  strategicSummary?: string;
  memorySummary?: string;
  objectiveKind?: AgentObjectiveKind;
  objectiveSummary?: string;
  objectiveAligned?: boolean;
  /** LegalAction.id values presented to the first brain call for this turn. */
  legalActionIDs: string[];
  legalActionIDsByKind: Partial<Record<LegalActionKind, string[]>>;
  /**
   * Roster-order reservation can narrow the first offer before submission. These
   * fields are present only when that submission set differs from the offer.
   */
  submissionLegalActionIDs?: string[];
  submissionLegalActionIDsByKind?: Partial<Record<LegalActionKind, string[]>>;
  /** Bounded, sanitized telemetry from the first brain response. */
  originalRequestedActionIDs?: string[];
  originalRequestedActionIDCount?: number;
  /** First-response ids that were offered but removed before submission. */
  withdrawnRequestedActionIDs?: string[];
  withdrawnRequestedActionIDCount?: number;
  /** At most one retry is permitted after an offered id is withdrawn. */
  offerRetryCount?: number;
  offerRetryLatencyMs?: number;
  attackActionIDs: string[];
  chosenActionID: string;
  chosenActionKind: LegalActionKind;
  reason: string;
  decisionMetadata?: Record<string, string | number | boolean | null>;
  chosenActionMetadata?: Record<string, string | number | boolean | null>;
  tacticalAffordances?: AgentTacticalAffordances;
  /**
   * Compact economy facts at this decision boundary
   * (PROXYWAR_TUNE_ECONOMY_EVENTS; absent when the flag is off). Rides the
   * permissive decision-record surface, never results.json.
   */
  economyFacts?: AgentEconomyRecordFacts;
  intent: Intent | null;
  result: AgentActionResult;
  audit?: AgentActionAudit;
}
