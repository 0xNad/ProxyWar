import winston from "winston";
import { GameEnv, ServerConfig } from "../core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../core/game/Game";
import { StampedIntent } from "../core/Schemas";
import { validateAgentDecision } from "../server/agents/AgentDecisionValidator";
import { AgentRunner } from "../server/agents/AgentRunner";
import { LegalAction } from "../server/agents/AgentTypes";
import { GameServer } from "../server/GameServer";

const log = winston.createLogger({
  level: "info",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

const serverConfig = {
  turnIntervalMs: () => 100,
  env: () => GameEnv.Dev,
} as ServerConfig;

const persistentID = "11111111-1111-4111-8111-111111111111";
const game = new GameServer(
  "AGENT001",
  log,
  Date.now(),
  serverConfig,
  {
    gameMap: GameMapType.Asia,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Private,
    difficulty: Difficulty.Medium,
    nations: "disabled",
    donateGold: false,
    donateTroops: false,
    bots: 0,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    disabledUnits: [],
  },
  persistentID,
);

const agent = new AgentRunner({
  agentID: "hardcoded-agent-1",
  username: "Agent One",
  persistentID,
  log,
});

const join = agent.attachToGame(game);
const spawnAction: LegalAction = {
  id: "spawn:smoke:10",
  kind: "spawn",
  label: "Spawn at tile 10",
  intent: { type: "spawn", tile: 10 },
  risk: { level: "none", score: 0 },
};
const decision = {
  actionID: spawnAction.id,
  reason: "Smoke test selects one offered LegalAction.id.",
};
const validation = validateAgentDecision(decision, [spawnAction]);
const intent =
  validation.ok === true
    ? agent.submitLegalAction(validation.action)
    : {
        accepted: false,
        reason: validation.reason,
        intent: null,
      };
const queuedIntents = (game as unknown as { intents: StampedIntent[] }).intents;

console.log("ProxyWar smoke result", {
  join,
  intent,
  queuedIntents: queuedIntents.map((queuedIntent) => ({
    type: queuedIntent.type,
    clientID: queuedIntent.clientID,
  })),
});

await game.end();
