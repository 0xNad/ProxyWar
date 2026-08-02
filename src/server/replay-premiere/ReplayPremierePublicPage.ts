import express, { type Request, type Response, type Router } from "express";
import { randomBytes } from "node:crypto";
import englishTranslations from "../../../resources/lang/en.json";
import { matchProxyWarPublicPremiereReadPath } from "../agents/ProxyWarPublicArtifacts";
import type { PolicyIdentity } from "./ReplayPremiereContracts";
import type { ReplayPremiereHttpRegistry } from "./ReplayPremiereHttp";
import type { PremierePublicBootstrapResponse } from "./ReplayPremiereWire";

const JSON_DOCUMENT_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox";
const SVG_DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; sandbox";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SCRIPT_NONCE_PATTERN = /^[A-Za-z0-9+/]{32}$/;

type ReplayPremiereTranslationSuffix =
  keyof typeof englishTranslations.replay_premiere;
type ReplayPremiereTranslationKey =
  `replay_premiere.${ReplayPremiereTranslationSuffix}`;

export interface ReplayPremierePublicPageOptions {
  registry: Pick<ReplayPremiereHttpRegistry, "get">;
  loadAppShell(): Promise<string>;
  publicOrigin: string;
  pageContentSecurityPolicy: string;
  onOperatorError?: (error: unknown) => void;
}

export function createReplayPremierePublicPageRouter(
  options: ReplayPremierePublicPageOptions,
): Router {
  const router = express.Router();
  const publicOrigin = exactPublicOrigin(options.publicOrigin);
  if (
    typeof options.pageContentSecurityPolicy !== "string" ||
    options.pageContentSecurityPolicy.trim() === ""
  ) {
    throw new Error("Replay Premiere page CSP is required");
  }
  parsePageContentSecurityPolicy(options.pageContentSecurityPolicy);

  router.use((request, response, next) => {
    const route = matchProxyWarPublicPremiereReadPath(request.path);
    if (route?.kind !== "page" && route?.kind !== "card") {
      next();
      return;
    }
    void handlePublicDocumentRequest({
      request,
      response,
      route,
      options,
      publicOrigin,
    }).catch((error: unknown) => {
      try {
        options.onOperatorError?.(error);
      } catch {
        // Operator diagnostics can never replace the fixed public response.
      }
      if (!response.headersSent) {
        sendFailure(response, 503, "PREMIERE_UNAVAILABLE");
      } else {
        response.destroy();
      }
    });
  });
  return router;
}

export function renderReplayPremierePageHtml(options: {
  appShell: string;
  bootstrap: PremierePublicBootstrapResponse;
  publicOrigin: string;
  scriptNonce: string;
}): string {
  const model = spoilerNeutralModel(options.bootstrap);
  const origin = exactPublicOrigin(options.publicOrigin);
  if (!/<head(?:\s[^>]*)?>/i.test(options.appShell)) {
    throw new Error("Replay Premiere app shell has no head element");
  }
  const canonicalUrl = new URL(`/premiere/${model.premiereId}`, origin).href;
  const cardUrl = new URL(`/premiere/${model.premiereId}/card-v1.svg`, origin)
    .href;
  const pageTitle = interpolate(translateText("replay_premiere.page_title"), {
    title: model.title,
  });
  const attribution = translateText("replay_premiere.asset_attribution");
  const noEndorsement = translateText("replay_premiere.no_endorsement");
  const metadata = [
    `<title>${escapeHtml(pageTitle)}</title>`,
    `<meta name="description" content="${escapeHtml(model.description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(pageTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(model.description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
    `<meta property="og:image" content="${escapeHtml(cardUrl)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(pageTitle)}">`,
    `<meta name="twitter:description" content="${escapeHtml(model.description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(cardUrl)}">`,
    `<meta name="proxywar:premiere_id" content="${escapeHtml(model.premiereId)}">`,
    `<meta name="proxywar:publication_commitment" content="${escapeHtml(model.publicationCommitmentHash)}">`,
    `<meta name="proxywar:eligibility_record" content="${escapeHtml(model.eligibilityRecordHash)}">`,
    `<meta name="proxywar:source_kind" content="${escapeHtml(model.sourceKind)}">`,
    `<meta name="proxywar:source_run_id" content="${escapeHtml(model.sourceRunId)}">`,
    `<meta name="proxywar:source_replay_sha256" content="${escapeHtml(model.sourceReplaySha256)}">`,
    `<meta name="proxywar:public_label" content="${escapeHtml(model.publicLabel)}">`,
    `<meta name="proxywar:asset_attribution" content="${escapeHtml(attribution)}">`,
    `<meta name="proxywar:no_endorsement" content="${escapeHtml(noEndorsement)}">`,
    ...coworldMetadata(model),
    ...model.seats.flatMap((seat, index) => seatMetadata(seat, index)),
  ].join("\n");
  const withoutExistingSocialMetadata = stripShellSocialMetadata(
    options.appShell,
  );
  const withPremiereMetadata = withoutExistingSocialMetadata.replace(
    /<head(?:\s[^>]*)?>/i,
    (head) => `${head}\n${metadata}`,
  );
  return nonceInlineScripts(withPremiereMetadata, options.scriptNonce);
}

export function renderReplayPremiereCardSvg(
  bootstrap: PremierePublicBootstrapResponse,
): string {
  const model = spoilerNeutralModel(bootstrap);
  const label = translateText("replay_premiere.label_premiere");
  const neutral = translateText("replay_premiere.card_spoiler_neutral");
  const map = `${translateText("replay_premiere.map")}: ${model.mapLabel}`;
  const format = `${translateText("replay_premiere.match_format")}: ${model.formatLabel}`;
  const participants = `${translateText("replay_premiere.participants")}: ${model.participants.join(" · ")}`;
  const policies = model.seats
    .map((seat) => policyDisplayLabel(seat))
    .join(" · ");
  const attribution = translateText("replay_premiere.asset_attribution");
  const noEndorsement = translateText("replay_premiere.no_endorsement");
  const seatIds = JSON.stringify(model.seats.map((seat) => seat.seatId));
  const policyIdentities = JSON.stringify(
    model.seats.map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
      policyIdentity: seat.policyIdentity,
    })),
  );
  const coworld =
    model.coworld === null ? "null" : JSON.stringify(model.coworld);
  const [descriptionLineOne, descriptionLineTwo] = wrapText(
    model.description,
    68,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(`${label}: ${model.title}`)}" data-premiere-id="${escapeXml(model.premiereId)}" data-publication-commitment="${escapeXml(model.publicationCommitmentHash)}" data-eligibility-record="${escapeXml(model.eligibilityRecordHash)}" data-source-kind="${escapeXml(model.sourceKind)}" data-source-run-id="${escapeXml(model.sourceRunId)}" data-source-replay-sha256="${escapeXml(model.sourceReplaySha256)}" data-public-label="${escapeXml(model.publicLabel)}" data-map-id="${escapeXml(model.mapId)}" data-format-id="${escapeXml(model.formatId)}" data-seat-ids="${escapeXml(seatIds)}" data-policy-identities="${escapeXml(policyIdentities)}" data-coworld="${escapeXml(coworld)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#090d16"/><stop offset="0.55" stop-color="#111a2c"/><stop offset="1" stop-color="#20152e"/></linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#66e3ff"/><stop offset="1" stop-color="#c76cff"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="54" y="54" width="1092" height="522" rx="30" fill="#0c1220" fill-opacity="0.88" stroke="#ffffff" stroke-opacity="0.12"/>
  <rect x="84" y="86" width="236" height="42" rx="21" fill="url(#accent)"/>
  <text x="202" y="114" text-anchor="middle" fill="#071019" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="800" letter-spacing="1.5">${escapeXml(label.toLocaleUpperCase("en-US"))}</text>
  <text x="1096" y="113" text-anchor="end" fill="#9caaca" font-family="Inter, Arial, sans-serif" font-size="18">${escapeXml(neutral)}</text>
  <text x="84" y="214" fill="#f7f9ff" font-family="Inter, Arial, sans-serif" font-size="58" font-weight="800">${escapeXml(truncateText(model.title, 34))}</text>
  <text x="84" y="278" fill="#c3cbe0" font-family="Inter, Arial, sans-serif" font-size="25">${escapeXml(descriptionLineOne)}</text>
  <text x="84" y="312" fill="#c3cbe0" font-family="Inter, Arial, sans-serif" font-size="25">${escapeXml(descriptionLineTwo)}</text>
  <line x1="84" y1="354" x2="1116" y2="354" stroke="#ffffff" stroke-opacity="0.12"/>
  <text x="84" y="392" fill="#8fa0c6" font-family="Inter, Arial, sans-serif" font-size="20">${escapeXml(map)}</text>
  <text x="84" y="426" fill="#8fa0c6" font-family="Inter, Arial, sans-serif" font-size="20">${escapeXml(format)}</text>
  <text x="84" y="460" fill="#8fa0c6" font-family="Inter, Arial, sans-serif" font-size="20">${escapeXml(truncateText(participants, 88))}</text>
  <text x="84" y="494" fill="#8fa0c6" font-family="Inter, Arial, sans-serif" font-size="17">${escapeXml(truncateText(policies, 116))}</text>
  <text x="84" y="532" fill="#7785a6" font-family="Inter, Arial, sans-serif" font-size="13">${escapeXml(attribution)}</text>
  <text x="84" y="556" fill="#7785a6" font-family="Inter, Arial, sans-serif" font-size="13">${escapeXml(noEndorsement)}</text>
  <text x="84" y="596" fill="#7584a8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15">${escapeXml(model.premiereId)}</text>
  <text x="1116" y="596" text-anchor="end" fill="#8fa0c6" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="700">${escapeXml(translateText("replay_premiere.card_watch"))}</text>
</svg>`;
}

async function handlePublicDocumentRequest(options: {
  request: Request;
  response: Response;
  route: { kind: "page" | "card"; premiereId: string };
  options: ReplayPremierePublicPageOptions;
  publicOrigin: string;
}): Promise<void> {
  const { request, response, route } = options;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendFailure(response, 405, "PREMIERE_INVALID_REQUEST");
    return;
  }
  if (request.headers.range !== undefined) {
    sendFailure(response, 416, "PREMIERE_INVALID_REQUEST");
    return;
  }
  const target = options.options.registry.get(route.premiereId);
  if (target === null) {
    // A stale/bookmarked link, or a premiere the autocycler has already
    // reclaimed (`cycle-premiere.sh` wipes the whole registry on every
    // cycle — see `ReplayPremiereArchiveIndex.ts`'s own doc on why
    // nothing about a past premiere survives that but the durable points
    // ledger). This used to unconditionally send the raw JSON error body
    // as the top-level document — Chrome's own JSON viewer, zero site
    // chrome, for a PLAIN BROWSER NAVIGATION (found live, QA screenshot
    // pass-4/m-20). Only `card` requests (SVG social-card embeds, never
    // a top-level document a person navigates to) and explicit
    // `Accept: application/json` callers keep that contract — an
    // ordinary browser `GET` now gets the same app shell a real premiere
    // page would, at the correct 404 status, so `PremiereEndedPage.ts`
    // (mounted client-side on the resulting `premiere_not_found` bootstrap
    // failure — see `ReplayPremiereNetwork.ts`) gets the chance to render
    // an honest, themed answer instead.
    if (route.kind === "page" && prefersHtmlDocument(request)) {
      const appShell = await options.options.loadAppShell();
      const scriptNonce = randomBytes(24).toString("base64");
      sendDocument(
        response,
        request.method,
        404,
        nonceInlineScripts(appShell, scriptNonce),
        {
          contentType: "text/html; charset=utf-8",
          contentSecurityPolicy: pageContentSecurityPolicyWithNonce(
            options.options.pageContentSecurityPolicy,
            scriptNonce,
          ),
        },
      );
      return;
    }
    sendFailure(response, 404, "PREMIERE_UNAVAILABLE");
    return;
  }
  const bootstrap = target.runtime.readBootstrap();
  if (bootstrap.premiereId !== route.premiereId) {
    throw new Error("Replay Premiere registry/bootstrap identity mismatch");
  }
  if (route.kind === "card") {
    sendDocument(
      response,
      request.method,
      200,
      renderReplayPremiereCardSvg(bootstrap),
      {
        contentType: "image/svg+xml; charset=utf-8",
        contentSecurityPolicy: SVG_DOCUMENT_CSP,
      },
    );
    return;
  }
  const appShell = await options.options.loadAppShell();
  const scriptNonce = randomBytes(24).toString("base64");
  sendDocument(
    response,
    request.method,
    200,
    renderReplayPremierePageHtml({
      appShell,
      bootstrap,
      publicOrigin: options.publicOrigin,
      scriptNonce,
    }),
    {
      contentType: "text/html; charset=utf-8",
      contentSecurityPolicy: pageContentSecurityPolicyWithNonce(
        options.options.pageContentSecurityPolicy,
        scriptNonce,
      ),
    },
  );
}

/**
 * True only when the request explicitly names `text/html` in `Accept` —
 * a real browser navigation always does (Chrome's default document
 * `Accept` starts `text/html,application/xhtml+xml,...`). Deliberately
 * NOT `request.accepts(["html","json"])`: that resolves an absent or
 * bare wildcard `Accept` header (curl, plain `fetch()`, this module's own
 * tests, any other non-browser API client) to `"html"` too, since it is
 * first in the preference list — which would silently break every
 * existing consumer of the `{"error":{"code":"PREMIERE_UNAVAILABLE"}}`
 * JSON contract for an unknown id. A bare/wildcard Accept keeps that
 * contract; only an EXPLICIT `text/html` preference gets the app shell.
 */
function prefersHtmlDocument(request: Request): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.toLowerCase().includes("text/html");
}

export function nonceInlineScripts(
  appShell: string,
  scriptNonce: string,
): string {
  assertScriptNonce(scriptNonce);
  let inlineScriptCount = 0;
  const rendered = appShell.replace(/<script\b[^>]*>/gi, (tag) => {
    if (hasTagAttribute(tag, "nonce")) {
      throw new Error("Replay Premiere app shell contains a preset nonce");
    }
    if (hasTagAttribute(tag, "src")) return tag;
    inlineScriptCount += 1;
    return `${tag.slice(0, -1)} nonce="${scriptNonce}">`;
  });
  if (inlineScriptCount === 0) {
    throw new Error("Replay Premiere app shell has no inline bootstrap script");
  }
  return rendered;
}

export function pageContentSecurityPolicyWithNonce(
  policy: string,
  scriptNonce: string,
): string {
  assertScriptNonce(scriptNonce);
  return parsePageContentSecurityPolicy(policy)
    .map((directive) => {
      const name = directive.split(/\s+/, 1)[0].toLocaleLowerCase("en-US");
      return name === "script-src" || name === "script-src-elem"
        ? `${directive} 'nonce-${scriptNonce}'`
        : directive;
    })
    .join("; ");
}

function parsePageContentSecurityPolicy(policy: string): string[] {
  if (hasControlCharacter(policy)) {
    throw new Error("Replay Premiere page CSP contains a control character");
  }
  const directives = policy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "");
  const seen = new Set<string>();
  for (const directive of directives) {
    const [rawName, ...sources] = directive.split(/\s+/);
    const name = rawName.toLocaleLowerCase("en-US");
    if (!/^[a-z][a-z0-9-]*$/.test(name) || seen.has(name)) {
      throw new Error("Replay Premiere page CSP is malformed");
    }
    seen.add(name);
    if (name === "script-src" || name === "script-src-elem") {
      if (
        sources.some((source) => {
          const normalized = source.toLocaleLowerCase("en-US");
          return (
            normalized === "'unsafe-inline'" ||
            normalized === "'unsafe-eval'" ||
            normalized.startsWith("'nonce-")
          );
        })
      ) {
        throw new Error("Replay Premiere page CSP has an unsafe script source");
      }
    }
  }
  if (!seen.has("script-src")) {
    throw new Error("Replay Premiere page CSP requires script-src");
  }
  return directives;
}

function assertScriptNonce(scriptNonce: string): void {
  if (!SCRIPT_NONCE_PATTERN.test(scriptNonce)) {
    throw new Error("Replay Premiere script nonce is invalid");
  }
}

function spoilerNeutralModel(bootstrap: PremierePublicBootstrapResponse): {
  premiereId: string;
  title: string;
  description: string;
  mapId: string;
  mapLabel: string;
  formatId: string;
  formatLabel: string;
  participants: string[];
  seats: Array<{
    seatId: string;
    displayName: string;
    policyIdentity: PolicyIdentity;
  }>;
  publicationCommitmentHash: string;
  eligibilityRecordHash: string;
  sourceKind: string;
  sourceRunId: string;
  sourceReplaySha256: string;
  coworld: PremierePublicBootstrapResponse["provenance"]["coworld"];
  publicLabel: string;
} {
  const definition = bootstrap.publicDefinition;
  const provenance = bootstrap.provenance;
  const strings = [
    bootstrap.premiereId,
    definition.title,
    definition.spoilerNeutralDescription,
    definition.map.id,
    definition.map.label,
    definition.matchFormat.id,
    definition.matchFormat.label,
    provenance.sourceKind,
    provenance.sourceRunId,
    provenance.sourceReplaySha256,
    provenance.publicLabel,
    ...provenance.seats.flatMap((seat) => [
      seat.seatId,
      seat.displayName,
      ...policyIdentityStrings(seat.policyIdentity),
    ]),
  ];
  if (
    bootstrap.schemaVersion !== 1 ||
    bootstrap.integrityScope.authoritativeResult !== "not_revealed" ||
    strings.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 512 ||
        hasControlCharacter(value),
    ) ||
    !HASH_PATTERN.test(bootstrap.publicationCommitmentHash) ||
    bootstrap.publicationCommitmentHash !==
      provenance.publicationCommitmentHash ||
    !HASH_PATTERN.test(provenance.eligibilityRecordHash) ||
    !HASH_PATTERN.test(provenance.sourceReplaySha256) ||
    provenance.seats.length < 2 ||
    provenance.seats.length !== definition.matchFormat.seatCount ||
    provenance.sourceKind !== definition.provenance.sourceKind ||
    provenance.sourceRunId !== definition.provenance.sourceRunId ||
    provenance.sourceReplaySha256 !==
      definition.provenance.sourceReplaySha256 ||
    provenance.eligibilityRecordHash !==
      definition.provenance.eligibilityRecordHash ||
    provenance.publicLabel !== definition.provenance.publicLabel ||
    JSON.stringify(provenance.coworld) !==
      JSON.stringify(definition.provenance.coworld) ||
    JSON.stringify(provenance.seats) !==
      JSON.stringify(definition.provenance.seats)
  ) {
    throw new Error("Replay Premiere bootstrap is unsafe for public metadata");
  }
  return {
    premiereId: bootstrap.premiereId,
    title: definition.title,
    description: definition.spoilerNeutralDescription,
    mapId: definition.map.id,
    mapLabel: definition.map.label,
    formatId: definition.matchFormat.id,
    formatLabel: definition.matchFormat.label,
    participants: provenance.seats.map((seat) => seat.displayName),
    seats: structuredClone(provenance.seats),
    publicationCommitmentHash: bootstrap.publicationCommitmentHash,
    eligibilityRecordHash: provenance.eligibilityRecordHash,
    sourceKind: provenance.sourceKind,
    sourceRunId: provenance.sourceRunId,
    sourceReplaySha256: provenance.sourceReplaySha256,
    coworld: structuredClone(provenance.coworld),
    publicLabel: provenance.publicLabel,
  };
}

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

/**
 * Strips every `<title>`, description meta, `og:*`/`twitter:*`/`proxywar:*`
 * meta, and canonical `<link>` from an app shell's `<head>` — shared by this
 * module's own premiere page AND `/match/:matchId`'s per-match OG injection
 * in `ai-agent-demo-server.ts` (`sendMatchDetailPageShell`), so there is one
 * strip implementation, not two that could drift.
 */
export function stripShellSocialMetadata(appShell: string): string {
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

function hasTagAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(?:\\s*=|\\s|/?>)`, "i").test(tag);
}

function seatMetadata(
  seat: {
    seatId: string;
    displayName: string;
    policyIdentity: PolicyIdentity;
  },
  index: number,
): string[] {
  const prefix = `proxywar:seat:${index}`;
  const common = [
    metadataTag(`${prefix}:id`, seat.seatId),
    metadataTag(`${prefix}:display_name`, seat.displayName),
    metadataTag(`${prefix}:policy_namespace`, seat.policyIdentity.namespace),
  ];
  return seat.policyIdentity.namespace === "softmax_policy_version"
    ? [
        ...common,
        metadataTag(
          `${prefix}:policy_version_id`,
          seat.policyIdentity.policyVersionId,
        ),
        metadataTag(`${prefix}:policy_name`, seat.policyIdentity.policyName),
        metadataTag(
          `${prefix}:server_assigned_version`,
          seat.policyIdentity.serverAssignedVersion,
        ),
      ]
    : [
        ...common,
        metadataTag(
          `${prefix}:manifest_name`,
          seat.policyIdentity.manifestName,
        ),
        metadataTag(
          `${prefix}:declared_version`,
          seat.policyIdentity.declaredVersion,
        ),
        metadataTag(
          `${prefix}:manifest_sha256`,
          seat.policyIdentity.manifestSha256,
        ),
        metadataTag(
          `${prefix}:content_sha256`,
          seat.policyIdentity.contentSha256,
        ),
      ];
}

function coworldMetadata(model: {
  coworld: PremierePublicBootstrapResponse["provenance"]["coworld"];
}): string[] {
  if (model.coworld === null) return [];
  return [
    metadataTag("proxywar:coworld:episode_id", model.coworld.episodeId),
    metadataTag("proxywar:coworld:league_id", model.coworld.leagueId),
    metadataTag("proxywar:coworld:division_id", model.coworld.divisionId),
    metadataTag("proxywar:coworld:round_id", model.coworld.roundId),
  ];
}

function metadataTag(name: string, content: string): string {
  return `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
}

function policyIdentityStrings(identity: PolicyIdentity): string[] {
  return identity.namespace === "softmax_policy_version"
    ? [
        identity.namespace,
        identity.policyVersionId,
        identity.policyName,
        identity.serverAssignedVersion,
      ]
    : [
        identity.namespace,
        identity.manifestName,
        identity.declaredVersion,
        identity.manifestSha256,
        identity.contentSha256,
      ];
}

function policyDisplayLabel(seat: {
  displayName: string;
  policyIdentity: PolicyIdentity;
}): string {
  return seat.policyIdentity.namespace === "softmax_policy_version"
    ? interpolate(translateText("replay_premiere.card_policy_softmax"), {
        displayName: seat.displayName,
        policyName: seat.policyIdentity.policyName,
        version: seat.policyIdentity.serverAssignedVersion,
      })
    : interpolate(translateText("replay_premiere.card_policy_local"), {
        displayName: seat.displayName,
        manifestName: seat.policyIdentity.manifestName,
        version: seat.policyIdentity.declaredVersion,
      });
}

function sendDocument(
  response: Response,
  method: string,
  status: number,
  body: string,
  options: { contentType: string; contentSecurityPolicy: string },
): void {
  setPublicDocumentHeaders(response, options.contentSecurityPolicy);
  response.status(status);
  response.setHeader("Content-Type", options.contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(method === "HEAD" ? undefined : body);
}

function sendFailure(
  response: Response,
  status: number,
  code: "PREMIERE_INVALID_REQUEST" | "PREMIERE_UNAVAILABLE",
): void {
  const body = JSON.stringify({ error: { code } });
  sendDocument(response, response.req.method, status, body, {
    contentType: "application/json; charset=utf-8",
    contentSecurityPolicy: JSON_DOCUMENT_CSP,
  });
}

function setPublicDocumentHeaders(
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
    throw new Error("Replay Premiere public origin is invalid");
  }
  return parsed.origin;
}

function wrapText(value: string, width: number): [string, string] {
  const words = value.trim().split(/\s+/);
  let first = "";
  let second = "";
  for (const word of words) {
    if (`${first} ${word}`.trim().length <= width && second === "") {
      first = `${first} ${word}`.trim();
    } else {
      second = `${second} ${word}`.trim();
    }
  }
  return [truncateText(first, width), truncateText(second, width)];
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}
