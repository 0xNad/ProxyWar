import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_COWORLD_POSTGAME_GRACE_MS = 30_000;
export const MIN_COWORLD_POSTGAME_GRACE_MS = 100;
export const MAX_COWORLD_POSTGAME_GRACE_MS = 30_000;
export const COWORLD_FORCED_TERMINATION_SETTLE_MS = 1_000;

export type CoworldTerminalSocket = {
  readyState: number;
  send(data: string): unknown;
  terminate(): unknown;
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
};

export type CoworldPlayerFinalization = {
  sentSlots: number[];
  skippedSlots: number[];
  sendFailedSlots: number[];
  closedSlots: number[];
  timedOutSlots: number[];
};

export type CoworldPreparedArtifact = {
  publish(): Promise<void>;
  discard(): Promise<void>;
};

export type CoworldPreparedTerminalArtifacts = {
  replay: CoworldPreparedArtifact;
  results: CoworldPreparedArtifact;
  discard(): Promise<void>;
};

export function coworldPostgameGraceMs(raw: string | undefined): number {
  const parsed =
    raw === undefined ? DEFAULT_COWORLD_POSTGAME_GRACE_MS : Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_COWORLD_POSTGAME_GRACE_MS;
  }
  return Math.min(
    MAX_COWORLD_POSTGAME_GRACE_MS,
    Math.max(MIN_COWORLD_POSTGAME_GRACE_MS, Math.trunc(parsed)),
  );
}

export function serializeCoworldJsonArtifact(
  value: unknown,
  label: "replay" | "results",
): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new Error(`Coworld ${label} artifact is not JSON-serializable`);
  }
  return `${serialized}\n`;
}

/**
 * Send the terminal frame to the exact player sockets that are still open, then
 * wait for those recipients to acknowledge terminal work (including any optional
 * artifact upload) by closing their websocket. The single shared deadline keeps
 * one lagging seat from adding a timeout of its own.
 */
export async function finalizeCoworldPlayers(
  players: ReadonlyMap<number, CoworldTerminalSocket>,
  openReadyState: number,
  timeoutMs: number,
): Promise<CoworldPlayerFinalization> {
  const sentSlots: number[] = [];
  const skippedSlots: number[] = [];
  const sendFailedSlots: number[] = [];
  const closedSlots: number[] = [];
  const recipients = [...players.entries()].filter(([slot, socket]) => {
    if (socket.readyState === openReadyState) {
      return true;
    }
    skippedSlots.push(slot);
    return false;
  });

  if (recipients.length === 0) {
    return sortedFinalization({
      sentSlots,
      skippedSlots,
      sendFailedSlots,
      closedSlots,
      timedOutSlots: [],
    });
  }

  return await new Promise<CoworldPlayerFinalization>((resolve, reject) => {
    const pending = new Map<number, CoworldTerminalSocket>();
    const closeListeners = new Map<number, () => void>();
    let settled = false;
    let sending = true;

    const removeCloseListeners = () => {
      for (const [slot, socket] of pending.entries()) {
        const listener = closeListeners.get(slot);
        if (listener !== undefined) {
          socket.off("close", listener);
        }
      }
      closeListeners.clear();
    };
    const complete = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      removeCloseListeners();
      resolve(
        sortedFinalization({
          sentSlots,
          skippedSlots,
          sendFailedSlots,
          closedSlots,
          timedOutSlots: [],
        }),
      );
    };
    const terminateTimedOut = async () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const timedOut = [...pending.entries()];
      removeCloseListeners();
      try {
        await terminateCoworldSockets(timedOut);
        resolve(
          sortedFinalization({
            sentSlots,
            skippedSlots,
            sendFailedSlots,
            closedSlots,
            timedOutSlots: timedOut.map(([slot]) => slot),
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(
      () => {
        void terminateTimedOut();
      },
      Math.max(0, timeoutMs),
    );

    for (const [slot, socket] of recipients) {
      const onClose = () => {
        if (!pending.delete(slot)) {
          return;
        }
        socket.off("close", onClose);
        closeListeners.delete(slot);
        closedSlots.push(slot);
        if (pending.size === 0 && !sending) {
          complete();
        }
      };
      pending.set(slot, socket);
      closeListeners.set(slot, onClose);
      socket.on("close", onClose);
    }

    for (const [slot, socket] of recipients) {
      if (!pending.has(slot)) {
        continue;
      }
      if (socket.readyState !== openReadyState) {
        pending.delete(slot);
        const listener = closeListeners.get(slot);
        if (listener !== undefined) {
          socket.off("close", listener);
          closeListeners.delete(slot);
        }
        skippedSlots.push(slot);
        continue;
      }
      try {
        socket.send(JSON.stringify({ type: "final", slot }));
        sentSlots.push(slot);
      } catch {
        sendFailedSlots.push(slot);
      }
    }

    sending = false;
    if (pending.size === 0) {
      complete();
    }
  });
}

async function terminateCoworldSockets(
  sockets: ReadonlyArray<readonly [number, CoworldTerminalSocket]>,
): Promise<void> {
  if (sockets.length === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const pending = new Map(sockets);
    const closeListeners = new Map<number, () => void>();
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      for (const [slot, socket] of pending.entries()) {
        const listener = closeListeners.get(slot);
        if (listener !== undefined) {
          socket.off("close", listener);
        }
      }
      closeListeners.clear();
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new Error(
          `Coworld player transport termination timed out for slots: ${[
            ...pending.keys(),
          ].join(",")}`,
        ),
      );
    }, COWORLD_FORCED_TERMINATION_SETTLE_MS);

    for (const [slot, socket] of sockets) {
      const onClose = () => {
        if (!pending.delete(slot)) {
          return;
        }
        socket.off("close", onClose);
        closeListeners.delete(slot);
        if (pending.size === 0 && !settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      closeListeners.set(slot, onClose);
      socket.on("close", onClose);
    }

    for (const [slot, socket] of sockets) {
      if (!pending.has(slot)) {
        continue;
      }
      try {
        socket.terminate();
      } catch (error) {
        fail(
          new Error(
            `Coworld player transport termination failed for slot ${slot}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        return;
      }
    }
  });
}

export async function runCoworldTerminalLifecycle<Prepared>(input: {
  prepare: () => Prepared | Promise<Prepared>;
  finalizePlayers: () =>
    | CoworldPlayerFinalization
    | Promise<CoworldPlayerFinalization>;
  beforePublish?: (
    finalization: CoworldPlayerFinalization,
  ) => void | Promise<void>;
  publishReplay: (prepared: Prepared) => void | Promise<void>;
  publishResults: (prepared: Prepared) => void | Promise<void>;
  discard?: (prepared: Prepared) => void | Promise<void>;
}): Promise<CoworldPlayerFinalization> {
  const prepared = await input.prepare();
  try {
    const finalization = await input.finalizePlayers();
    await input.beforePublish?.(finalization);
    await input.publishReplay(prepared);
    await input.publishResults(prepared);
    return finalization;
  } catch (error) {
    try {
      await input.discard?.(prepared);
    } catch {
      // Preserve the terminal failure; staged-file cleanup is best effort.
    }
    throw error;
  }
}

export async function prepareCoworldTerminalArtifacts(input: {
  replay: { uri: string; body: string | Buffer; contentType: string };
  results: { uri: string; body: string | Buffer; contentType: string };
}): Promise<CoworldPreparedTerminalArtifacts> {
  const replay = await prepareCoworldArtifactUri(
    input.replay.uri,
    input.replay.body,
    input.replay.contentType,
  );
  try {
    const results = await prepareCoworldArtifactUri(
      input.results.uri,
      input.results.body,
      input.results.contentType,
    );
    return {
      replay,
      results,
      discard: async () => {
        await Promise.all([replay.discard(), results.discard()]);
      },
    };
  } catch (error) {
    await replay.discard().catch(() => undefined);
    throw error;
  }
}

export async function prepareCoworldArtifactUri(
  uri: string,
  body: string | Buffer,
  contentType: string,
): Promise<CoworldPreparedArtifact> {
  if (/^https?:\/\//.test(uri)) {
    let published = false;
    return {
      publish: async () => {
        if (published) {
          return;
        }
        let response: Response;
        try {
          response = await fetch(uri, {
            method: "PUT",
            headers: { "content-type": contentType },
            // string | Buffer is accepted by Node's fetch at runtime; the DOM
            // BodyInit type loaded by the monorepo does not model Buffer.
            body: body as BodyInit,
          });
        } catch {
          throw new Error(`${publicArtifactUri(uri)} upload failed`);
        }
        if (!response.ok) {
          throw new Error(
            `${publicArtifactUri(uri)} returned HTTP ${response.status}`,
          );
        }
        published = true;
      },
      discard: async () => undefined,
    };
  }

  const explicitScheme = uri.match(/^([a-zA-Z][a-zA-Z\d+.-]*):\/\//)?.[1];
  if (explicitScheme !== undefined && explicitScheme !== "file") {
    throw new Error(
      `Unsupported Coworld artifact URI scheme: ${explicitScheme}`,
    );
  }
  const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, body);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  let published = false;
  return {
    publish: async () => {
      if (published) {
        return;
      }
      await fs.rename(temporaryPath, filePath);
      published = true;
    },
    discard: async () => {
      if (!published) {
        await fs.rm(temporaryPath, { force: true });
      }
    },
  };
}

function publicArtifactUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "Coworld artifact URI";
  }
}

function sortedFinalization(
  value: CoworldPlayerFinalization,
): CoworldPlayerFinalization {
  return {
    sentSlots: [...value.sentSlots].sort((a, b) => a - b),
    skippedSlots: [...value.skippedSlots].sort((a, b) => a - b),
    sendFailedSlots: [...value.sendFailedSlots].sort((a, b) => a - b),
    closedSlots: [...value.closedSlots].sort((a, b) => a - b),
    timedOutSlots: [...value.timedOutSlots].sort((a, b) => a - b),
  };
}
