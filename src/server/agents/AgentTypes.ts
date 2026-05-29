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
  | "planner-executor"
  | "llm";

export type AgentRuntimeMode =
  | "local-policy-baseline"
  | "mock-policy-planner"
  | "llm-policy-planner"
  | "llm-action-selector";

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
  allianceExpiresAt?: number;
  allianceInExtensionWindow?: boolean;
  relativeTroopRatio?: number;
  spawnDistance?: number;
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

export interface AgentTacticalAffordances {
  transportTroopBanking: AgentTransportTroopBankingAffordance;
  openingExpansionTempo?: AgentOpeningExpansionTempoAffordance;
  frontierConversionTiming?: AgentFrontierConversionTimingAffordance;
  frontierFinishPressure?: AgentFrontierFinishPressureAffordance;
  economyCadence?: AgentEconomyCadenceAffordance;
  navalControl?: AgentNavalControlAffordance;
  lateGameStrikeTargeting?: AgentLateGameStrikeTargetingAffordance;
  personalityDiplomacyPressure?: AgentPersonalityDiplomacyPressureAffordance;
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

export interface AgentObservation {
  agentID: string;
  clientID: string | null;
  username: string;
  profile: AgentStrategyProfile;
  gameID: string;
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
  legalActionIDs: string[];
  legalActionIDsByKind: Partial<Record<LegalActionKind, string[]>>;
  attackActionIDs: string[];
  chosenActionID: string;
  chosenActionKind: LegalActionKind;
  reason: string;
  decisionMetadata?: Record<string, string | number | boolean | null>;
  chosenActionMetadata?: Record<string, string | number | boolean | null>;
  tacticalAffordances?: AgentTacticalAffordances;
  intent: Intent | null;
  result: AgentActionResult;
  audit?: AgentActionAudit;
}
