import type { Request, Response } from "express";

/**
 * Abort-safe streaming for the public artifact routes.
 *
 * The premiere loop's admission leak collector fetches the deployment origin's
 * public artifact routes with a per-target byte ceiling and aborts the response
 * mid-stream once the ceiling is crossed (see
 * `ReplayPremiereLeakAuditCollector`). When the aborted route was serving a
 * large file with `res.sendFile`, the status line and headers are already on
 * the wire, so the naive `sendFile` error callback
 * (`res.status(404).send(...)`) throws `ERR_HTTP_HEADERS_SENT` ("Cannot set
 * headers after they are sent to the client"). That throw happens inside
 * `sendFile`'s asynchronous callback with nothing to catch it, so it becomes an
 * uncaught exception and crashes the whole beta server — launchd's KeepAlive
 * then restarts the process, i.e. a live-site outage on every over-ceiling
 * fetch. This module keeps the artifact routes from ever re-sending headers
 * after a client abort.
 */

/** Options forwarded to `res.sendFile` (the express `SendFileOptions` subset we use). */
export interface PublicArtifactSendOptions {
  root?: string;
  dotfiles?: "allow" | "deny" | "ignore";
  headers?: Record<string, string>;
  maxAge?: number | string;
  lastModified?: boolean;
  cacheControl?: boolean;
  acceptRanges?: boolean;
}

/**
 * True when the error is a client-side hang-up (aborted request, reset socket,
 * broken pipe, or a stream torn down underneath us) rather than a genuine
 * server-side failure. These must never be turned into a fresh HTTP response.
 */
export function isClientAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === "ECONNABORTED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ERR_STREAM_DESTROYED"
  );
}

/**
 * Complete an artifact response after `res.sendFile`'s callback fires.
 *
 * A `null`/`undefined` error means the file streamed cleanly — nothing to do.
 * Otherwise: if the response head is already committed (headers sent), the
 * response is already ended, or the failure is a client abort, we can no longer
 * set a status or body without throwing `ERR_HTTP_HEADERS_SENT`, so we tear the
 * response down quietly. Only a genuine pre-stream failure (e.g. a missing file
 * where nothing has been written yet) becomes the intended `404`.
 */
export function finishArtifactResponse(
  res: Response,
  error: NodeJS.ErrnoException | null | undefined,
  notFoundMessage: string,
): void {
  if (error === undefined || error === null) {
    return;
  }
  if (res.headersSent || res.writableEnded || isClientAbortError(error)) {
    if (!res.writableEnded && !res.destroyed) {
      // Best effort: close our side of an already-committed/aborted response
      // without writing anything new. `end()` on a torn-down socket is a no-op.
      try {
        res.end();
      } catch {
        // The socket is already gone; nothing further to do.
      }
    }
    return;
  }
  res.status(404).send(notFoundMessage);
}

/**
 * `res.sendFile` with client-abort handling baked in. Attaches absorbing
 * `error` listeners to the request and response (a late socket error after
 * `send` has detached would otherwise be an unhandled `'error'` that crashes
 * the process) and routes the completion callback through
 * {@link finishArtifactResponse} so a mid-stream abort can never re-send
 * headers.
 */
export function sendPublicArtifactFile(
  req: Request,
  res: Response,
  filePath: string,
  notFoundMessage: string,
  options?: PublicArtifactSendOptions,
): void {
  const absorb = (error: unknown): void => {
    if (!isClientAbortError(error)) {
      console.error(
        `Public artifact stream error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  req.on("error", absorb);
  res.on("error", absorb);

  const done = (error?: Error): void => {
    finishArtifactResponse(
      res,
      (error as NodeJS.ErrnoException | undefined) ?? null,
      notFoundMessage,
    );
  };

  if (options === undefined) {
    res.sendFile(filePath, done);
  } else {
    res.sendFile(filePath, options, done);
  }
}
