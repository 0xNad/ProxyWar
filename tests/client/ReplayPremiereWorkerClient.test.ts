import { describe, expect, it, vi } from "vitest";
import {
  REPLAY_PREMIERE_TURN_BATCH_SIZE,
  ReplayPremiereWorkerClient,
} from "../../src/client/ReplayPremiereWorkerClient";
import { Turn } from "../../src/core/Schemas";

class FakeReplayWorker {
  readonly posted: unknown[] = [];
  readonly terminate = vi.fn();
  private listener:
    | ((event: MessageEvent<Record<string, unknown>>) => void)
    | null = null;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<Record<string, unknown>>) => void,
  ): void {
    this.listener = listener;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  emit(message: Record<string, unknown>): void {
    this.listener?.({ data: message } as MessageEvent<Record<string, unknown>>);
  }
}

function initializationId(worker: FakeReplayWorker): string {
  const init = worker.posted[0] as { type: string; id: string };
  expect(init.type).toBe("init");
  return init.id;
}

describe("ReplayPremiereWorkerClient", () => {
  it("coalesces a production-length replay into bounded worker messages", async () => {
    const worker = new FakeReplayWorker();
    const microtasks: Array<() => void> = [];
    const client = new ReplayPremiereWorkerClient({} as never, undefined, {
      workerFactory: () => worker as never,
      enqueueMicrotask: (callback) => microtasks.push(callback),
    });
    const initialized = client.initialize();
    worker.emit({ type: "initialized", id: initializationId(worker) });
    await initialized;

    const startedAt = performance.now();
    for (let turnNumber = 0; turnNumber < 59_100; turnNumber += 1) {
      client.sendTurn({ turnNumber, intents: [] } as Turn);
    }
    expect(microtasks).toHaveLength(1);
    microtasks.shift()?.();
    const elapsedMs = performance.now() - startedAt;

    const batches = worker.posted.slice(1) as Array<{
      type: string;
      turns: Turn[];
    }>;
    expect(batches).toHaveLength(
      Math.ceil(59_100 / REPLAY_PREMIERE_TURN_BATCH_SIZE),
    );
    expect(batches.every((batch) => batch.type === "turn_batch")).toBe(true);
    expect(
      batches.every(
        (batch) =>
          batch.turns.length > 0 &&
          batch.turns.length <= REPLAY_PREMIERE_TURN_BATCH_SIZE,
      ),
    ).toBe(true);
    expect(batches.flatMap((batch) => batch.turns)).toHaveLength(59_100);
    expect(elapsedMs).toBeLessThan(5_000);
    client.cleanup();
  });

  it("delivers one coalesced update with its logical completion count", async () => {
    const worker = new FakeReplayWorker();
    const client = new ReplayPremiereWorkerClient({} as never, undefined, {
      workerFactory: () => worker as never,
      enqueueMicrotask: (callback) => callback(),
    });
    const initialized = client.initialize();
    worker.emit({ type: "initialized", id: initializationId(worker) });
    await initialized;

    const received: Array<{
      completedTurns: number;
      tickExecutionDurations: readonly number[] | undefined;
    }> = [];
    client.start(() => {
      received.push({
        completedTurns: client.completedTurnsForCurrentUpdate(),
        tickExecutionDurations: client.tickExecutionDurationsForCurrentUpdate(),
      });
    });
    worker.emit({
      type: "game_update_batch",
      gameUpdates: [{}],
      completedTurns: 3,
      tickExecutionDurations: [1, 2, 3],
    });
    expect(received).toEqual([
      { completedTurns: 3, tickExecutionDurations: [1, 2, 3] },
    ]);
    expect(client.completedTurnsForCurrentUpdate()).toBe(1);
    expect(client.tickExecutionDurationsForCurrentUpdate()).toBeUndefined();
    client.cleanup();
  });

  it("terminates and fails closed on worker initialization error", async () => {
    const worker = new FakeReplayWorker();
    const client = new ReplayPremiereWorkerClient({} as never, undefined, {
      workerFactory: () => worker as never,
    });
    const initialized = client.initialize();
    worker.emit({
      type: "initialization_error",
      id: initializationId(worker),
    });

    await expect(initialized).rejects.toThrow("Worker initialization failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(() =>
      client.sendTurn({ turnNumber: 0, intents: [] } as Turn),
    ).toThrow("Replay worker not initialized");
  });

  it("terminates a worker whose initialization times out", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeReplayWorker();
      const client = new ReplayPremiereWorkerClient({} as never, undefined, {
        workerFactory: () => worker as never,
      });
      const initialized = client.initialize();
      const rejected = expect(initialized).rejects.toThrow(
        "Worker initialization timeout",
      );
      await vi.advanceTimersByTimeAsync(60_000);

      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the GameView query surface, including false results", async () => {
    const worker = new FakeReplayWorker();
    const client = new ReplayPremiereWorkerClient({} as never, undefined, {
      workerFactory: () => worker as never,
    });
    const initialized = client.initialize();
    worker.emit({ type: "initialized", id: initializationId(worker) });
    await initialized;

    const profile = { id: 7 };
    const profileResult = client.playerProfile(7);
    const profileRequest = worker.posted.at(-1) as {
      type: string;
      id: string;
      playerID: number;
    };
    expect(profileRequest).toMatchObject({
      type: "player_profile",
      playerID: 7,
    });
    worker.emit({
      type: "player_profile_result",
      id: profileRequest.id,
      result: profile,
    });
    await expect(profileResult).resolves.toBe(profile);

    const spawnResult = client.transportShipSpawn(7 as never, 10 as never);
    const spawnRequest = worker.posted.at(-1) as {
      type: string;
      id: string;
    };
    worker.emit({
      type: "transport_ship_spawn_result",
      id: spawnRequest.id,
      result: false,
    });
    await expect(spawnResult).resolves.toBe(false);
    client.cleanup();
  });

  it("rejects outstanding queries when the worker is disposed", async () => {
    const worker = new FakeReplayWorker();
    const client = new ReplayPremiereWorkerClient({} as never, undefined, {
      workerFactory: () => worker as never,
    });
    const initialized = client.initialize();
    worker.emit({ type: "initialized", id: initializationId(worker) });
    await initialized;

    const pending = client.playerBorderTiles(7 as never);
    const rejected = expect(pending).rejects.toThrow(
      "Replay worker is unavailable",
    );
    client.cleanup();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
