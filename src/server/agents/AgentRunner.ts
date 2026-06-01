import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { Logger } from "winston";
import { WebSocket } from "ws";
import {
  ClientIntentMessage,
  ClientIntentMessageSchema,
  ClientMessage,
  Intent,
  PlayerCosmetics,
  ServerMessage,
  ServerMessageSchema,
} from "../../core/Schemas";
import { generateID, replacer } from "../../core/Util";
import { Client } from "../Client";
import { GameServer } from "../GameServer";
import { LegalAction } from "./AgentTypes";

export type AgentJoinResult =
  | { status: "joined"; clientID: string }
  | { status: "already_joined"; clientID: string }
  | { status: "kicked" | "rejected"; reason: string };

export interface AgentIntentResult {
  accepted: boolean;
  reason: string;
  intent: Intent | null;
}

export interface AgentRunnerOptions {
  agentID?: string;
  clientID?: string;
  username: string;
  persistentID?: string;
  clanTag?: string | null;
  ip?: string;
  cosmetics?: PlayerCosmetics;
  log: Logger;
}

class InProcessAgentSocket extends EventEmitter {
  public readyState: number = WebSocket.OPEN;
  private readonly sentMessages: ServerMessage[] = [];

  send(data: unknown, cb?: (err?: Error) => void): void {
    const text = this.toText(data);
    try {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        this.sentMessages.push(parsed.data);
      }
      cb?.();
    } catch (error) {
      cb?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(_code?: number, _reason?: string): void {
    if (this.readyState === WebSocket.CLOSED) {
      return;
    }
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.close();
  }

  emitClientMessage(message: ClientMessage): void {
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error("agent socket is not open");
    }
    this.emit("message", JSON.stringify(message, replacer));
  }

  messages(): ServerMessage[] {
    return [...this.sentMessages];
  }

  private toText(data: unknown): string {
    if (typeof data === "string") {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data.toString("utf8");
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data.map((part) => Buffer.from(part))).toString(
        "utf8",
      );
    }
    return String(data);
  }
}

export class AgentRunner {
  public readonly agentID: string;
  public readonly persistentID: string;

  private readonly initialClientID: string;
  private readonly username: string;
  private readonly clanTag: string | null;
  private readonly ip: string;
  private readonly cosmetics: PlayerCosmetics | undefined;
  private readonly log: Logger;

  private client: Client | null = null;
  private socket: InProcessAgentSocket | null = null;

  constructor(options: AgentRunnerOptions) {
    this.agentID = options.agentID ?? generateID();
    this.initialClientID = options.clientID ?? generateID();
    this.persistentID = options.persistentID ?? randomUUID();
    this.username = options.username;
    this.clanTag = options.clanTag ?? null;
    this.ip = options.ip ?? "127.0.0.1";
    this.cosmetics = options.cosmetics;
    this.log = options.log.child({
      comp: "agent_runner",
      agentID: this.agentID,
    });

    this.log.info("agent created", {
      username: this.username,
      persistentID: this.persistentID,
    });
  }

  attachToGame(game: GameServer): AgentJoinResult {
    if (this.client !== null) {
      this.log.info("agent already joined", {
        gameID: game.id,
        clientID: this.client.clientID,
      });
      return { status: "already_joined", clientID: this.client.clientID };
    }

    const socket = new InProcessAgentSocket();
    const client = new Client(
      this.initialClientID,
      this.persistentID,
      null,
      null,
      undefined,
      this.ip,
      this.username,
      this.clanTag,
      socket as unknown as WebSocket,
      this.cosmetics,
    );

    const joinResult = game.joinClient(client);
    if (joinResult === "joined") {
      this.client = client;
      this.socket = socket;
      this.log.info("agent joined", {
        gameID: game.id,
        clientID: client.clientID,
      });
      return { status: "joined", clientID: client.clientID };
    }

    socket.close();
    this.log.warn("agent join rejected", {
      gameID: game.id,
      result: joinResult,
    });
    return { status: joinResult, reason: joinResult };
  }

  submitLegalAction(action: LegalAction): AgentIntentResult {
    this.log.info("agent legal action submitted", {
      actionID: action.id,
      actionKind: action.kind,
    });

    if (action.intent === null) {
      return {
        accepted: true,
        reason: "hold action selected; no game intent submitted",
        intent: null,
      };
    }

    return this.submitIntent(action.intent);
  }

  private submitIntent(intent: Intent): AgentIntentResult {
    this.log.info("agent intent submitted", {
      intentType: intent.type,
    });

    if (this.client === null || this.socket === null) {
      const reason = "agent has not joined a game";
      this.log.warn("agent intent rejected", {
        intentType: intent.type,
        reason,
      });
      return { accepted: false, reason, intent };
    }

    const message = {
      type: "intent",
      intent,
    } satisfies ClientIntentMessage;
    const parsed = ClientIntentMessageSchema.safeParse(message);
    if (!parsed.success) {
      const reason = parsed.error.message;
      this.log.warn("agent intent rejected", {
        intentType: intent.type,
        reason,
      });
      return { accepted: false, reason, intent };
    }

    const previousMessageCount = this.socket.messages().length;

    try {
      this.socket.emitClientMessage(parsed.data);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log.warn("agent intent rejected", {
        intentType: intent.type,
        reason,
      });
      return { accepted: false, reason, intent };
    }

    const newMessages = this.socket.messages().slice(previousMessageCount);
    const serverError = newMessages.find((msg) => msg.type === "error");
    if (serverError !== undefined) {
      this.log.warn("agent intent rejected", {
        intentType: intent.type,
        reason: serverError.error,
      });
      return { accepted: false, reason: serverError.error, intent };
    }

    this.log.info("agent intent accepted", {
      intentType: intent.type,
      acceptance: "no immediate server error",
    });
    return { accepted: true, reason: "accepted", intent };
  }

  clientID(): string | null {
    return this.client?.clientID ?? null;
  }

  serverMessages(): ServerMessage[] {
    return this.socket?.messages() ?? [];
  }
}
