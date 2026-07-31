import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assembleCoworldResults } from "../../coworld-adapter/src/coworld-episode-output";
import {
  coworldEpisodeSeedContract,
  coworldGameID,
} from "../../coworld-adapter/src/coworld-seed";
import {
  COWORLD_FORCED_TERMINATION_SETTLE_MS,
  DEFAULT_COWORLD_POSTGAME_GRACE_MS,
  MAX_COWORLD_POSTGAME_GRACE_MS,
  MIN_COWORLD_POSTGAME_GRACE_MS,
  coworldPostgameGraceMs,
  finalizeCoworldPlayers,
  prepareCoworldArtifactUri,
  prepareCoworldTerminalArtifacts,
  runCoworldTerminalLifecycle,
  serializeCoworldJsonArtifact,
  type CoworldTerminalSocket,
} from "../../coworld-adapter/src/coworld-terminal-lifecycle";

class FakeSocket extends EventEmitter implements CoworldTerminalSocket {
  readonly messages: string[] = [];
  closeOnSend = false;
  throwOnSend = false;
  terminateEmitsClose = true;
  terminateCalls = 0;

  constructor(public readyState: number) {
    super();
  }

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.messages.push(data);
    if (this.closeOnSend) {
      this.close();
    }
  }

  close(): void {
    this.emit("close");
  }

  terminate(): void {
    this.terminateCalls += 1;
    if (this.terminateEmitsClose) {
      this.close();
    }
  }
}

const scratchDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Coworld terminal player finalization", () => {
  it("sends the exact terminal frame only to OPEN sockets", async () => {
    vi.useFakeTimers();
    const open = new FakeSocket(1);
    const connecting = new FakeSocket(0);
    const closing = new FakeSocket(2);
    const closed = new FakeSocket(3);

    const finalizationPromise = finalizeCoworldPlayers(
      new Map([
        [0, open],
        [1, connecting],
        [2, closing],
        [3, closed],
      ]),
      1,
      1000,
    );

    expect(open.messages).toEqual(['{"type":"final","slot":0}']);
    expect(connecting.messages).toEqual([]);
    expect(closing.messages).toEqual([]);
    expect(closed.messages).toEqual([]);

    open.close();
    await expect(finalizationPromise).resolves.toEqual({
      sentSlots: [0],
      skippedSlots: [1, 2, 3],
      sendFailedSlots: [],
      closedSlots: [0],
      timedOutSlots: [],
    });
  });

  it("uses one bounded deadline and removes listeners from lagging sockets", async () => {
    vi.useFakeTimers();
    const fast = new FakeSocket(1);
    const lagging = new FakeSocket(1);
    const finalizationPromise = finalizeCoworldPlayers(
      new Map([
        [0, fast],
        [1, lagging],
      ]),
      1,
      750,
    );

    fast.close();
    await vi.advanceTimersByTimeAsync(749);
    expect(lagging.listenerCount("close")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(finalizationPromise).resolves.toEqual({
      sentSlots: [0, 1],
      skippedSlots: [],
      sendFailedSlots: [],
      closedSlots: [0],
      timedOutSlots: [1],
    });
    expect(lagging.listenerCount("close")).toBe(0);
    expect(lagging.terminateCalls).toBe(1);
  });

  it("continues finalizing other seats when one OPEN socket throws on send", async () => {
    vi.useFakeTimers();
    const broken = new FakeSocket(1);
    broken.throwOnSend = true;
    const healthy = new FakeSocket(1);
    const finalizationPromise = finalizeCoworldPlayers(
      new Map([
        [0, broken],
        [1, healthy],
      ]),
      1,
      500,
    );

    expect(healthy.messages).toEqual(['{"type":"final","slot":1}']);
    healthy.close();
    await vi.advanceTimersByTimeAsync(500);

    await expect(finalizationPromise).resolves.toEqual({
      sentSlots: [1],
      skippedSlots: [],
      sendFailedSlots: [0],
      closedSlots: [1],
      timedOutSlots: [0],
    });
  });

  it("records a synchronous close without losing the sent terminal frame", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(1);
    socket.closeOnSend = true;

    await expect(
      finalizeCoworldPlayers(new Map([[0, socket]]), 1, 500),
    ).resolves.toEqual({
      sentSlots: [0],
      skippedSlots: [],
      sendFailedSlots: [],
      closedSlots: [0],
      timedOutSlots: [],
    });
  });

  it("rejects instead of publishing past a transport that cannot terminate", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(1);
    socket.terminateEmitsClose = false;
    const finalizationPromise = finalizeCoworldPlayers(
      new Map([[0, socket]]),
      1,
      100,
    );
    const rejection = expect(finalizationPromise).rejects.toThrow(
      "Coworld player transport termination timed out for slots: 0",
    );

    await vi.advanceTimersByTimeAsync(
      100 + COWORLD_FORCED_TERMINATION_SETTLE_MS,
    );
    await rejection;
    expect(socket.terminateCalls).toBe(1);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("forcibly closes a real nonresponsive websocket before resolving", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test websocket server did not bind");
    }
    const serverSocketPromise = new Promise<WebSocket>((resolve) =>
      server.once("connection", resolve),
    );
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve) => client.once("open", resolve));
    const serverSocket = await serverSocketPromise;

    try {
      await expect(
        finalizeCoworldPlayers(
          new Map([[0, serverSocket]]),
          WebSocket.OPEN,
          25,
        ),
      ).resolves.toEqual({
        sentSlots: [0],
        skippedSlots: [],
        sendFailedSlots: [],
        closedSlots: [],
        timedOutSlots: [0],
      });
      expect(serverSocket.readyState).toBe(WebSocket.CLOSED);
      await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.CLOSED));
    } finally {
      client.terminate();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Coworld artifacts-last lifecycle", () => {
  it("prepares, finalizes players, then publishes replay and results last", async () => {
    const trace: string[] = [];

    await runCoworldTerminalLifecycle({
      prepare: () => {
        trace.push("prepare");
        return { replay: "replay", results: "results" };
      },
      finalizePlayers: () => {
        trace.push("final");
        return {
          sentSlots: [0],
          skippedSlots: [],
          sendFailedSlots: [],
          closedSlots: [0],
          timedOutSlots: [],
        };
      },
      beforePublish: () => {
        trace.push("drained");
      },
      publishReplay: async () => {
        trace.push("replay");
      },
      publishResults: async () => {
        trace.push("results");
      },
    });

    expect(trace).toEqual(["prepare", "final", "drained", "replay", "results"]);
  });

  it("keeps staged artifacts invisible and preserves seed/game_id in results published last", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-coworld-terminal-seed-"),
    );
    scratchDirectories.push(directory);
    const replayPath = path.join(directory, "replay");
    const resultsPath = path.join(directory, "results.json");
    const seedContract = coworldEpisodeSeedContract({ seed: 162024 });
    const results = assembleCoworldResults(
      {
        scores: [1, 0],
        winner_slot: 0,
        turn_count: 100,
        tick: 100,
        decision_count: 2,
        accepted_decision_count: 2,
        fallback_count: 0,
        degraded_count: 0,
        players: [],
      },
      seedContract,
    );
    const trace: string[] = [];

    await runCoworldTerminalLifecycle({
      prepare: async () =>
        await prepareCoworldTerminalArtifacts({
          replay: {
            uri: replayPath,
            body: serializeCoworldJsonArtifact(
              {
                seed: seedContract.seed,
                gameID: seedContract.gameID,
                results,
              },
              "replay",
            ),
            contentType: "application/json",
          },
          results: {
            uri: resultsPath,
            body: serializeCoworldJsonArtifact(results, "results"),
            contentType: "application/json",
          },
        }),
      finalizePlayers: async () => {
        trace.push("final");
        await expect(fs.stat(replayPath)).rejects.toThrow();
        await expect(fs.stat(resultsPath)).rejects.toThrow();
        return {
          sentSlots: [0, 1],
          skippedSlots: [],
          sendFailedSlots: [],
          closedSlots: [0, 1],
          timedOutSlots: [],
        };
      },
      publishReplay: async (prepared) => {
        trace.push("replay");
        await prepared.replay.publish();
        await expect(fs.stat(replayPath)).resolves.toBeDefined();
        await expect(fs.stat(resultsPath)).rejects.toThrow();
      },
      publishResults: async (prepared) => {
        trace.push("results");
        await prepared.results.publish();
      },
      discard: async (prepared) => await prepared.discard(),
    });

    expect(trace).toEqual(["final", "replay", "results"]);
    const persistedResults = JSON.parse(await fs.readFile(resultsPath, "utf8"));
    expect(persistedResults).toMatchObject({
      seed: 162024,
      game_id: coworldGameID(162024),
    });
    expect(persistedResults.game_id).toBe(seedContract.gameID);
  });

  it("publishes nothing if preparation fails", async () => {
    const finalizePlayers = vi.fn();
    const publishReplay = vi.fn();
    const publishResults = vi.fn();

    await expect(
      runCoworldTerminalLifecycle({
        prepare: () => {
          throw new Error("invalid replay");
        },
        finalizePlayers,
        publishReplay,
        publishResults,
      }),
    ).rejects.toThrow("invalid replay");

    expect(finalizePlayers).not.toHaveBeenCalled();
    expect(publishReplay).not.toHaveBeenCalled();
    expect(publishResults).not.toHaveBeenCalled();
  });

  it("does not claim completion when either artifact publication fails", async () => {
    const publishResults = vi.fn();

    await expect(
      runCoworldTerminalLifecycle({
        prepare: () => "prepared",
        finalizePlayers: () => ({
          sentSlots: [],
          skippedSlots: [],
          sendFailedSlots: [],
          closedSlots: [],
          timedOutSlots: [],
        }),
        publishReplay: () => {
          throw new Error("replay upload failed");
        },
        publishResults,
      }),
    ).rejects.toThrow("replay upload failed");

    expect(publishResults).not.toHaveBeenCalled();
  });

  it("discards staging and publishes nothing when forced player termination fails", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(1);
    socket.terminateEmitsClose = false;
    const publishReplay = vi.fn();
    const publishResults = vi.fn();
    const discard = vi.fn();
    const lifecyclePromise = runCoworldTerminalLifecycle({
      prepare: () => "prepared",
      finalizePlayers: () =>
        finalizeCoworldPlayers(new Map([[0, socket]]), 1, 100),
      publishReplay,
      publishResults,
      discard,
    });
    const rejection = expect(lifecyclePromise).rejects.toThrow(
      "Coworld player transport termination timed out for slots: 0",
    );

    await vi.advanceTimersByTimeAsync(
      100 + COWORLD_FORCED_TERMINATION_SETTLE_MS,
    );
    await rejection;
    expect(publishReplay).not.toHaveBeenCalled();
    expect(publishResults).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledExactlyOnceWith("prepared");
  });
});

describe("Coworld terminal artifact publication", () => {
  it("clamps the player-final deadline to a finite safe range", () => {
    expect(coworldPostgameGraceMs(undefined)).toBe(
      DEFAULT_COWORLD_POSTGAME_GRACE_MS,
    );
    expect(coworldPostgameGraceMs("not-a-number")).toBe(
      DEFAULT_COWORLD_POSTGAME_GRACE_MS,
    );
    expect(coworldPostgameGraceMs("0")).toBe(MIN_COWORLD_POSTGAME_GRACE_MS);
    expect(coworldPostgameGraceMs("999999")).toBe(
      MAX_COWORLD_POSTGAME_GRACE_MS,
    );
  });

  it("rejects non-JSON output before terminal publication", () => {
    expect(() => serializeCoworldJsonArtifact(undefined, "results")).toThrow(
      "Coworld results artifact is not JSON-serializable",
    );
  });

  it("publishes complete local artifacts by atomic replacement", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-coworld-terminal-"),
    );
    scratchDirectories.push(directory);
    const replayPath = path.join(directory, "replay.json");
    const resultsPath = path.join(directory, "results.json");

    const replay = await prepareCoworldArtifactUri(
      pathToFileURL(replayPath).href,
      '{"replay":true}\n',
      "application/json",
    );
    const results = await prepareCoworldArtifactUri(
      resultsPath,
      '{"scores":[1,0]}\n',
      "application/json",
    );

    expect(await fs.readdir(directory)).toHaveLength(2);
    await expect(fs.stat(replayPath)).rejects.toThrow();
    await expect(fs.stat(resultsPath)).rejects.toThrow();

    await replay.publish();
    await results.publish();

    expect(await fs.readFile(replayPath, "utf8")).toBe('{"replay":true}\n');
    expect(await fs.readFile(resultsPath, "utf8")).toBe('{"scores":[1,0]}\n');
    expect((await fs.readdir(directory)).sort()).toEqual([
      "replay.json",
      "results.json",
    ]);
  });

  it("never exposes a presigned query string in HTTP publication errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );
    const artifact = await prepareCoworldArtifactUri(
      "https://uploads.example/replay?token=private-value",
      "replay",
      "application/octet-stream",
    );

    let errorMessage = "";
    try {
      await artifact.publish();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toBe(
      "https://uploads.example/replay returned HTTP 403",
    );
    expect(errorMessage).not.toContain("private-value");
  });

  it("rejects unsupported URI schemes instead of treating them as paths", async () => {
    await expect(
      prepareCoworldArtifactUri(
        "s3://bucket/results.json",
        "{}",
        "application/json",
      ),
    ).rejects.toThrow("Unsupported Coworld artifact URI scheme: s3");
  });
});
