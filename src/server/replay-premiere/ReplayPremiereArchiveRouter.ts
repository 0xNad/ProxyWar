import express, { type Request, type Response, type Router } from "express";
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import englishTranslations from "../../../resources/lang/en.json";
import { matchProxyWarPublicPremiereReadPath } from "../agents/ProxyWarPublicArtifacts";
import type {
  PremiereArchivePointerV1,
  ReplayPremiereArchiveStore,
} from "./ReplayPremiereArchiveIndex";
import {
  archivedPremiereClipFileName,
  archivedPremiereClipRoute,
  archivedPremiereClipsDir,
} from "./ReplayPremiereClips";
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

/** The archived page's downloadable-clip descriptor (stat-derived, no schema). */
export interface PremiereArchiveClientClip {
  /** Same-origin download route (`/premiere/<id>/clip.mp4`). */
  url: string;
  byteLength: number;
}

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
  /**
   * Canonical generation target for a retained, renderable completed replay.
   * Capability flags remain the independent process-level emergency gate.
   */
  clipGenerationTarget: {
    kind: "league_run";
    replayRunKey: string;
  } | null;
  /**
   * The durable archived clip, when one was promoted at reclamation and still
   * exists on disk (retention-bounded). Availability is a stat of the artifact
   * — the durable summary schema is untouched.
   */
  clip: PremiereArchiveClientClip | null;
  summary: PremiereResultSummaryV1;
}

export interface ReplayPremiereArchiveRouterOptions {
  registry: Pick<ReplayPremiereHttpRegistry, "get">;
  archiveStore: ReplayPremiereArchiveStore;
  loadAppShell(): Promise<string>;
  publicOrigin: string;
  pageContentSecurityPolicy: string;
  /** True only while the ordinary replay source is retained and renderable. */
  resolveClipGenerationTarget?: (replayRunKey: string) => Promise<boolean>;
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
    if (
      route === null ||
      (route.kind !== "page" &&
        route.kind !== "card" &&
        route.kind !== "archive_clip")
    ) {
      next();
      return;
    }
    // The durable-clip route is owned here TERMINALLY: no downstream premiere
    // router serves it, so every state (registered/live, unknown, failed,
    // missing artifact) is an identical fixed 404 and nothing falls through to
    // generic handling.
    if (route.kind === "archive_clip") {
      void handleArchivedClipRequest({
        request,
        response,
        route,
        options,
      }).catch((error: unknown) => {
        try {
          options.onOperatorError?.(error);
        } catch {
          // Operator diagnostics can never replace the fixed public response.
        }
        if (!response.headersSent) {
          sendFailure(response, 404);
        } else {
          response.destroy();
        }
      });
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

/**
 * Serves `GET|HEAD /premiere/<id>/clip.mp4` — the ONE durable clip promoted at
 * reclamation. Fail-closed: anything but a reveal-public archived premiere
 * with an on-disk artifact is the same bare 404 (unknown id, still-registered
 * premiere, failed/cancelled terminal, evicted clip). Post-reveal-public, so
 * the mp4 itself is cacheable; the noindex robots header stays.
 */
async function handleArchivedClipRequest(context: {
  request: Request;
  response: Response;
  route: { premiereId: string };
  options: ReplayPremiereArchiveRouterOptions;
}): Promise<void> {
  const { request, response, route, options } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendFailure(response, 405);
    return;
  }
  if (request.headers.range !== undefined) {
    sendFailure(response, 416);
    return;
  }
  const clip = await resolveArchivedClipFile(
    options.archiveStore,
    options.registry,
    route.premiereId,
  );
  if (clip === null) {
    sendFailure(response, 404);
    return;
  }
  setArchivedClipSuccessHeaders(response);
  response.status(200);
  response.setHeader("Content-Type", "video/mp4");
  response.setHeader("Content-Length", clip.byteLength);
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${archivedPremiereClipFileName(route.premiereId)}"`,
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(clip.filePath);
  stream.on("error", () => {
    if (!response.headersSent) sendFailure(response, 404);
    else response.destroy();
  });
  stream.pipe(response);
}

/**
 * Resolves the durable clip artifact for a premiere id, or null (=> 404).
 * Requires: not live-registered, archived pointer present, reveal-public
 * (revealedAt non-null, terminal revealed|archived), artifact on disk.
 */
async function resolveArchivedClipFile(
  archiveStore: ReplayPremiereArchiveRouterOptions["archiveStore"],
  registry: ReplayPremiereArchiveRouterOptions["registry"],
  premiereId: string,
): Promise<{ filePath: string; byteLength: number } | null> {
  if (registry.get(premiereId) !== null) return null;
  const pointer = archiveStore.lookup(premiereId);
  if (
    pointer === null ||
    pointer.revealedAt === null ||
    (pointer.terminalState !== "revealed" &&
      pointer.terminalState !== "archived")
  ) {
    return null;
  }
  const filePath = path.join(
    archivedPremiereClipsDir(archiveStore.archiveRoot),
    archivedPremiereClipFileName(premiereId),
  );
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    return { filePath, byteLength: stat.size };
  } catch {
    return null;
  }
}

function setArchivedClipSuccessHeaders(response: Response): void {
  // Public post-reveal artifact: cacheable (unlike premiere pages/cache clips).
  response.setHeader("Cache-Control", "public, max-age=3600");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
  );
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
  const clip = await resolveArchivedClipFile(
    options.archiveStore,
    options.registry,
    route.premiereId,
  );
  const replayRunKey =
    summary.sourceKind === "rated_coworld"
      ? publicRunKeyForSourceRunId(summary.sourceRunId)
      : null;
  const clipGenerationTarget =
    replayRunKey !== null &&
    summary.revealedAt !== null &&
    (summary.terminalState === "revealed" ||
      summary.terminalState === "archived") &&
    options.resolveClipGenerationTarget !== undefined &&
    (await options.resolveClipGenerationTarget(replayRunKey).catch(() => false))
      ? { kind: "league_run" as const, replayRunKey }
      : null;
  const payload: PremiereArchiveClientPayload = {
    schemaVersion: 1,
    premiereId: summary.premiereId,
    sourceRunId: summary.sourceRunId,
    sourceKind: summary.sourceKind,
    terminalState: summary.terminalState,
    revealedAt: summary.revealedAt,
    replayRunKey,
    clipGenerationTarget,
    clip:
      clip === null
        ? null
        : {
            url: archivedPremiereClipRoute(summary.premiereId),
            byteLength: clip.byteLength,
          },
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
  // Reveal-public archives get a real social card again (the same URL that
  // unfurled with a card during the premiere). Winner/standings language reaches
  // meta ONLY when the summary carries an outcome — which, by construction, only
  // a post-reveal (revealed/archived) summary ever does; failed/cancelled and
  // archived-without-reveal stay neutral. Deliberately no og:image: the card
  // image route intentionally 404s, so this is a text-only card.
  const meta = archivedSocialMetadata(options.payload.summary);
  // `<` is escaped inside the JSON island so it can never break out of the
  // non-executing data block; the client reads it by element id.
  const dataJson = JSON.stringify(options.payload).replaceAll("<", "\\u003c");
  const injected = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`,
    `<meta name="proxywar:premiere_archived" content="1">`,
    `<meta name="proxywar:premiere_id" content="${escapeHtml(options.payload.premiereId)}">`,
    `<script type="application/json" id="${ARCHIVE_DATA_ELEMENT_ID}">${dataJson}</script>`,
  ].join("\n");
  // Strip the app shell's generic site card first so exactly one set of social
  // tags survives (mirrors the live premiere page).
  const withoutShellSocial = stripShellSocialMetadata(options.appShell);
  const withInjection = withoutShellSocial.replace(
    /<head(?:\s[^>]*)?>/i,
    (head) => `${head}\n${injected}`,
  );
  return nonceInlineScripts(withInjection, options.scriptNonce);
}

/**
 * Builds the archived page's title + description from the durable summary.
 *
 * SPOILER GATE: an outcome is present only on a reveal-public summary
 * (validateSummaryPreimage rejects an outcome on failed/cancelled, and the
 * archive index never holds a pre-reveal id), so winner/standings language is
 * emitted only when `summary.outcome !== null`. Failed/cancelled/archived-
 * without-reveal fall through to a neutral, outcome-free card.
 */
function archivedSocialMetadata(summary: PremiereResultSummaryV1): {
  title: string;
  description: string;
} {
  const outcome = summary.outcome;
  if (outcome === null) {
    return {
      title: translateText("replay_premiere.archived_meta_ended_title"),
      description: translateText(
        "replay_premiere.archived_meta_ended_description",
      ),
    };
  }
  const wonStandings = outcome.standings.filter((standing) => standing.won);
  const soleWinner = wonStandings.length === 1 ? wonStandings[0] : null;
  const title =
    soleWinner === null
      ? translateText("replay_premiere.archived_meta_results_title")
      : interpolate(
          translateText("replay_premiere.archived_meta_winner_title"),
          { name: soleWinner.displayName },
        );
  const revealedDate = (summary.revealedAt ?? outcome.completedAt).slice(0, 10);
  let description = interpolate(
    translateText("replay_premiere.archived_meta_description"),
    {
      agents: String(outcome.standings.length),
      turns: String(outcome.turnCount),
      date: revealedDate,
    },
  );
  if (typeof summary.mapLabel === "string" && summary.mapLabel.length > 0) {
    description += ` · ${summary.mapLabel}`;
  }
  return { title, description };
}

type ReplayPremiereTranslationSuffix =
  keyof typeof englishTranslations.replay_premiere;
type ReplayPremiereTranslationKey =
  `replay_premiere.${ReplayPremiereTranslationSuffix}`;

function translateText(key: ReplayPremiereTranslationKey): string {
  const suffix = key.slice(
    "replay_premiere.".length,
  ) as ReplayPremiereTranslationSuffix;
  return englishTranslations.replay_premiere[suffix];
}

function interpolate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match,
  );
}

// Mirrors the live premiere page: drops the shell's <title>, canonical link, and
// every description/og:/twitter:/proxywar: tag so the archived injection owns the
// page's social metadata outright.
function stripShellSocialMetadata(appShell: string): string {
  return appShell
    .replace(/<title(?:\s[^>]*)?>[\s\S]*?<\/title>/gi, "")
    .replace(/<(?:meta|link)\b[^>]*>/gi, (tag) => {
      const rel = tagAttribute(tag, "rel")?.toLocaleLowerCase("en-US");
      if (rel?.split(/\s+/).includes("canonical") === true) return "";
      const identity = (
        tagAttribute(tag, "name") ?? tagAttribute(tag, "property")
      )?.toLocaleLowerCase("en-US");
      if (
        identity === "description" ||
        identity?.startsWith("og:") === true ||
        identity?.startsWith("twitter:") === true ||
        identity?.startsWith("proxywar:") === true
      ) {
        return "";
      }
      return tag;
    });
}

function tagAttribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
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
