import express, { type Request, type Response, type Router } from "express";
import { randomBytes } from "node:crypto";
import { matchProxyWarPublicPremiereReadPath } from "../agents/ProxyWarPublicArtifacts";
import type {
  PremiereArchivePointerV1,
  ReplayPremiereArchiveStore,
} from "./ReplayPremiereArchiveIndex";
import type { ReplayPremiereHttpRegistry } from "./ReplayPremiereHttp";
import { publicRunKeyForSourceRunId } from "./ReplayPremiereLoopCore";
import {
  escapeHtml,
  nonceInlineScripts,
  pageContentSecurityPolicyWithNonce,
} from "./ReplayPremierePublicPage";
import type { PremiereResultSummaryV1 } from "./ReplayPremiereResultSummary";

const JSON_DOCUMENT_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox";
const ARCHIVE_DATA_ELEMENT_ID = "proxywar-premiere-archive";

/** The exact JSON the archived premiere page hands the client to render. */
export interface PremiereArchiveClientPayload {
  schemaVersion: 1;
  premiereId: string;
  sourceRunId: string;
  sourceKind: PremiereResultSummaryV1["sourceKind"];
  terminalState: PremiereResultSummaryV1["terminalState"];
  revealedAt: string | null;
  /** The ordinary league replay run key to render behind the summary, or null. */
  replayRunKey: string | null;
  summary: PremiereResultSummaryV1;
}

export interface ReplayPremiereArchiveRouterOptions {
  registry: Pick<ReplayPremiereHttpRegistry, "get">;
  archiveStore: ReplayPremiereArchiveStore;
  loadAppShell(): Promise<string>;
  publicOrigin: string;
  pageContentSecurityPolicy: string;
  onOperatorError?: (error: unknown) => void;
}

/**
 * Serves revealed/terminal premieres whose live runtime has de-registered (e.g.
 * after a restart, or once the bulk was reclaimed). It MUST mount before the
 * premiere public-page router: for a still-registered premiere it defers to the
 * live path, and for an unknown id it defers so the live router returns the
 * fixed 404. It only ever serves ids present in the durable archive index, so a
 * pre-reveal premiere can never be exposed here.
 */
export function createReplayPremiereArchiveRouter(
  options: ReplayPremiereArchiveRouterOptions,
): Router {
  const router = express.Router();
  const publicOrigin = exactPublicOrigin(options.publicOrigin);
  if (
    typeof options.pageContentSecurityPolicy !== "string" ||
    options.pageContentSecurityPolicy.trim() === ""
  ) {
    throw new Error("Replay Premiere archive page CSP is required");
  }

  router.use((request, response, next) => {
    const route = matchProxyWarPublicPremiereReadPath(request.path);
    if (route === null || (route.kind !== "page" && route.kind !== "card")) {
      next();
      return;
    }
    // A live premiere is owned by the downstream public-page router/API.
    if (options.registry.get(route.premiereId) !== null) {
      next();
      return;
    }
    const pointer = options.archiveStore.lookup(route.premiereId);
    if (pointer === null) {
      // Unknown or still pre-reveal (never indexed): let the live router 404.
      next();
      return;
    }
    void handleArchivedDocumentRequest({
      request,
      response,
      route,
      pointer,
      options,
      publicOrigin,
    }).catch((error: unknown) => {
      try {
        options.onOperatorError?.(error);
      } catch {
        // Operator diagnostics can never replace the fixed public response.
      }
      if (!response.headersSent) {
        sendFailure(response, 503);
      } else {
        response.destroy();
      }
    });
  });
  return router;
}

async function handleArchivedDocumentRequest(context: {
  request: Request;
  response: Response;
  route: { kind: "page" | "card"; premiereId: string };
  pointer: PremiereArchivePointerV1;
  options: ReplayPremiereArchiveRouterOptions;
  publicOrigin: string;
}): Promise<void> {
  const { request, response, route, pointer, options } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendFailure(response, 405);
    return;
  }
  if (request.headers.range !== undefined) {
    sendFailure(response, 416);
    return;
  }
  // Card/asset routes for an archived premiere behave sanely: a bare 404,
  // indistinguishable from a nonexistent card.
  if (route.kind === "card") {
    sendFailure(response, 404);
    return;
  }
  const summary = await options.archiveStore.loadSummary(route.premiereId);
  if (summary === null || summary.premiereId !== pointer.premiereId) {
    sendFailure(response, 404);
    return;
  }
  const payload: PremiereArchiveClientPayload = {
    schemaVersion: 1,
    premiereId: summary.premiereId,
    sourceRunId: summary.sourceRunId,
    sourceKind: summary.sourceKind,
    terminalState: summary.terminalState,
    revealedAt: summary.revealedAt,
    replayRunKey:
      summary.sourceKind === "rated_coworld"
        ? publicRunKeyForSourceRunId(summary.sourceRunId)
        : null,
    summary,
  };
  const shell = await options.loadAppShell();
  const scriptNonce = randomBytes(24).toString("base64");
  const html = renderReplayPremiereArchivePageHtml({
    appShell: shell,
    payload,
    publicOrigin: context.publicOrigin,
    scriptNonce,
  });
  sendDocument(response, request.method, 200, html, {
    contentType: "text/html; charset=utf-8",
    contentSecurityPolicy: pageContentSecurityPolicyWithNonce(
      options.pageContentSecurityPolicy,
      scriptNonce,
    ),
  });
}

export function renderReplayPremiereArchivePageHtml(options: {
  appShell: string;
  payload: PremiereArchiveClientPayload;
  publicOrigin: string;
  scriptNonce: string;
}): string {
  if (!/<head(?:\s[^>]*)?>/i.test(options.appShell)) {
    throw new Error("Replay Premiere archive app shell has no head element");
  }
  const origin = exactPublicOrigin(options.publicOrigin);
  const canonicalUrl = new URL(
    `/premiere/${options.payload.premiereId}`,
    origin,
  ).href;
  const title = `Premiere replay · ${options.payload.premiereId}`;
  // `<` is escaped inside the JSON island so it can never break out of the
  // non-executing data block; the client reads it by element id.
  const dataJson = JSON.stringify(options.payload).replaceAll("<", "\\u003c");
  const injected = [
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
    `<meta name="proxywar:premiere_archived" content="1">`,
    `<meta name="proxywar:premiere_id" content="${escapeHtml(options.payload.premiereId)}">`,
    `<script type="application/json" id="${ARCHIVE_DATA_ELEMENT_ID}">${dataJson}</script>`,
  ].join("\n");
  const withoutTitle = options.appShell.replace(
    /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/gi,
    "",
  );
  const withInjection = withoutTitle.replace(
    /<head(?:\s[^>]*)?>/i,
    (head) => `${head}\n${injected}`,
  );
  return nonceInlineScripts(withInjection, options.scriptNonce);
}

function sendDocument(
  response: Response,
  method: string,
  status: number,
  body: string,
  options: { contentType: string; contentSecurityPolicy: string },
): void {
  setArchiveDocumentHeaders(response, options.contentSecurityPolicy);
  response.status(status);
  response.setHeader("Content-Type", options.contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(method === "HEAD" ? undefined : body);
}

function sendFailure(response: Response, status: number): void {
  const body = JSON.stringify({ error: { code: "PREMIERE_UNAVAILABLE" } });
  setArchiveDocumentHeaders(response, JSON_DOCUMENT_CSP);
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(response.req.method === "HEAD" ? undefined : body);
}

function setArchiveDocumentHeaders(
  response: Response,
  contentSecurityPolicy: string,
): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("CDN-Cache-Control", "no-store");
  response.setHeader("Surrogate-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Vary", "Origin, Cookie");
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "same-origin");
  response.removeHeader("ETag");
}

function exactPublicOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("Replay Premiere archive public origin is invalid");
  }
  return parsed.origin;
}
