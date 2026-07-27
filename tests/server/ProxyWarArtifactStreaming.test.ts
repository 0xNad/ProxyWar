import type { Response } from "express";
import express from "express";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  finishArtifactResponse,
  isClientAbortError,
  sendPublicArtifactFile,
} from "../../src/server/agents/ProxyWarArtifactStreaming";

describe("isClientAbortError", () => {
  test("recognizes client hang-up codes", () => {
    for (const code of [
      "ECONNABORTED",
      "ECONNRESET",
      "EPIPE",
      "ERR_STREAM_PREMATURE_CLOSE",
      "ERR_STREAM_DESTROYED",
    ]) {
      expect(isClientAbortError({ code })).toBe(true);
    }
  });

  test("does not flag genuine server-side failures or non-errors", () => {
    expect(isClientAbortError({ code: "ENOENT" })).toBe(false);
    expect(isClientAbortError(new Error("boom"))).toBe(false);
    expect(isClientAbortError(null)).toBe(false);
    expect(isClientAbortError(undefined)).toBe(false);
    expect(isClientAbortError("ECONNRESET")).toBe(false);
  });
});

describe("finishArtifactResponse", () => {
  function fakeResponse(overrides: Partial<Response>): {
    res: Response;
    status: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  } {
    const send = vi.fn();
    const status = vi.fn(() => ({ send }) as unknown as Response);
    const end = vi.fn();
    const res = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      status,
      send,
      end,
      ...overrides,
    } as unknown as Response;
    return { res, status, send, end };
  }

  test("no-op on a clean stream (null error)", () => {
    const { res, status, end } = fakeResponse({});
    finishArtifactResponse(res, null, "not found");
    expect(status).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  test("sends 404 only when the head is still ours (pre-stream failure)", () => {
    const { res, status, send } = fakeResponse({ headersSent: false });
    finishArtifactResponse(
      res,
      { code: "ENOENT" } as NodeJS.ErrnoException,
      "not found",
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(send).toHaveBeenCalledWith("not found");
  });

  test("never re-sends headers after they are committed (the crash guard)", () => {
    const { res, status, send, end } = fakeResponse({ headersSent: true });
    finishArtifactResponse(
      res,
      { code: "ECONNABORTED" } as NodeJS.ErrnoException,
      "not found",
    );
    // The bug was: res.status(404).send(...) here threw ERR_HTTP_HEADERS_SENT.
    expect(status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("treats a client abort as unrecoverable even before headersSent flips", () => {
    const { res, status, send } = fakeResponse({ headersSent: false });
    finishArtifactResponse(
      res,
      { code: "ECONNRESET" } as NodeJS.ErrnoException,
      "not found",
    );
    expect(status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test("does not call end() when the response is already ended", () => {
    const { res, end } = fakeResponse({
      headersSent: true,
      writableEnded: true,
    });
    finishArtifactResponse(
      res,
      { code: "EPIPE" } as NodeJS.ErrnoException,
      "not found",
    );
    expect(end).not.toHaveBeenCalled();
  });
});

describe("sendPublicArtifactFile integration — mid-stream client abort", () => {
  let server: Server | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("aborting a large response mid-stream does not crash the server, which stays responsive", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "artifact-abort-"));
    // Large enough that it cannot be flushed in a single TCP write, so the
    // client abort lands while the server is mid-body (headers already sent).
    const bigFile = path.join(tempDir, "spectator-replay.json");
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x7a);
    await writeFile(bigFile, payload);

    const app = express();
    app.get("/artifact", (req, res) => {
      sendPublicArtifactFile(req, res, bigFile, "artifact not found");
    });
    app.get("/missing", (req, res) => {
      sendPublicArtifactFile(
        req,
        res,
        path.join(tempDir ?? "", "does-not-exist.json"),
        "artifact not found",
      );
    });

    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    // Capture any uncaught exception the abort might surface. The pre-fix code
    // threw ERR_HTTP_HEADERS_SENT out of sendFile's async callback here.
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    try {
      // Abort the request as soon as the body starts arriving.
      await new Promise<void>((resolve, reject) => {
        const request = get(
          { host: "127.0.0.1", port, path: "/artifact" },
          (response) => {
            const abort = (): void => {
              response.destroy();
              request.destroy();
              resolve();
            };
            response.once("data", abort);
            response.once("end", resolve);
          },
        );
        request.on("error", () => resolve());
        request.setTimeout(5_000, () => {
          request.destroy();
          reject(new Error("request timed out"));
        });
      });

      // Give the server a tick to process the aborted socket / run sendFile's
      // callback (where the crash used to happen).
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(uncaught).toEqual([]);

      // The server must still be alive and serving: a follow-up request
      // returns the full artifact (a crashed process would have been restarted
      // by launchd in prod; here the socket would simply refuse).
      const fullBody = await new Promise<Buffer>((resolve, reject) => {
        get({ host: "127.0.0.1", port, path: "/artifact" }, (response) => {
          expect(response.statusCode).toBe(200);
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve(Buffer.concat(chunks)));
          response.on("error", reject);
        }).on("error", reject);
      });
      expect(fullBody.byteLength).toBe(payload.byteLength);

      // A missing file still yields a clean 404 (headers-not-yet-sent path).
      const missingStatus = await new Promise<number>((resolve, reject) => {
        get({ host: "127.0.0.1", port, path: "/missing" }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }).on("error", reject);
      });
      expect(missingStatus).toBe(404);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  test("a HEAD probe of an existing artifact returns 200 with no body (the loop's already-public probe)", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "artifact-head-"));
    const file = path.join(tempDir, "spectator.html");
    await writeFile(file, "<html></html>");

    const app = express();
    app.get("/probe", (req, res) => {
      sendPublicArtifactFile(req, res, file, "artifact not found");
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const request = get({
      host: "127.0.0.1",
      port,
      path: "/probe",
      method: "HEAD",
    });
    const [response] = (await once(request, "response")) as [
      { statusCode?: number },
    ];
    expect(response.statusCode).toBe(200);
  });
});
