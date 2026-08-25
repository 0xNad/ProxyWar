import { Execution, Game, Player, PlayerID } from "../game/Game";

/**
 * Free-text agent negotiation (PROXYWAR_TUNE_FREETEXT_MESSAGES, default OFF).
 *
 * Delivers one agent-authored private message. Deliberately inert: it emits a
 * display update and nothing else. It grants no permission, creates no
 * obligation, moves no troops, and touches no player state, so message text
 * cannot influence the simulation or its game-state hash. The replay payload
 * intentionally records the message, so changing the words changes that
 * payload's file/content hash. Talk is free; only the structured-deal
 * meta-actions bind.
 *
 * Length and character validation happen upstream (`AgentDecisionValidator`,
 * then `AgentMessageIntentSchema`). By the time text reaches here it is
 * already bounded, so this execution does not re-trim: silently rewriting an
 * agent's words would falsify the negotiation evidence built on them.
 */
export class AgentMessageExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private sender: Player,
    private recipientID: PlayerID,
    private text: string,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    // A recipient can be eliminated between the decision and this tick. Drop
    // the message rather than throwing: a dead counterparty is ordinary play,
    // not an error, and killing the execution keeps the tick deterministic.
    if (!mg.hasPlayer(this.recipientID)) {
      this.active = false;
    }
  }

  tick(ticks: number): void {
    if (!this.active) {
      return;
    }
    this.mg.displayAgentMessage(this.text, this.sender.id(), this.recipientID);
    this.active = false;
  }

  owner(): Player {
    return this.sender;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
