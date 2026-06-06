import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LobbyConfig } from "../../src/client/ClientGameRunner";
import { Transport } from "../../src/client/Transport";
import { EventBus } from "../../src/core/EventBus";
import { ClientHashMessage, ClientMessage } from "../../src/core/Schemas";
import { replacer } from "../../src/core/Util";

// Minimal controllable WebSocket stub. The reconnect-buffer path only reads the
// readyState constants off the global WebSocket and only uses send()/close()/
// onopen on the instance, so this is the whole surface it touches — no real
// socket or network needed. Instances default to CLOSED, which models a
// persistently-unavailable server: every Transport.sendMsg then takes the
// buffering branch, so we can queue several messages and watch them drain.
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CLOSED;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

// Only the fields the remote-transport path reads. gameRecord/gameStartInfo are
// left undefined so the Transport runs the remote (non-local) code path.
function makeLobbyConfig(): LobbyConfig {
  return {
    serverConfig: { workerPath: () => "worker-path" },
    gameID: "test-game",
  } as unknown as LobbyConfig;
}

describe("Transport reconnect buffer", () => {
  const RealWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    // Neutralize the ping setInterval started by connectRemote.
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = RealWebSocket;
    vi.useRealTimers();
  });

  it("re-sends buffered messages in original (FIFO) order on reopen", () => {
    const transport = new Transport(makeLobbyConfig(), new EventBus());
    transport.connect(
      () => {},
      () => {},
    );

    const messages: ClientHashMessage[] = [
      { type: "hash", hash: 1, turnNumber: 1 },
      { type: "hash", hash: 2, turnNumber: 2 },
      { type: "hash", hash: 3, turnNumber: 3 },
    ];

    // Each send sees a CLOSED socket and buffers (Transport tears down the
    // socket and reconnects a fresh one each time), so all three queue up.
    const internals = transport as unknown as {
      sendMsg: (msg: ClientMessage) => void;
    };
    for (const msg of messages) {
      internals.sendMsg(msg);
    }

    // The live socket is the most recently created one; reopen it.
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    socket.readyState = FakeWebSocket.OPEN;
    expect(socket.onopen).toBeTypeOf("function");
    socket.onopen!();

    // Without the FIFO fix (pop() instead of shift()) these would arrive
    // reversed: hash 3, 2, 1.
    expect(socket.sent).toEqual(
      messages.map((msg) => JSON.stringify(msg, replacer)),
    );
  });
});
