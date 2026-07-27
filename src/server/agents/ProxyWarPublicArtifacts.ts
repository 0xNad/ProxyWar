export const proxyWarPublicRunArtifacts = [
  "game-record.json",
  "decisions.jsonl",
  "match-summary.json",
  "replay-ui.json",
  "match-package.json",
  "match-package.html",
  "match-package.md",
  "spectator-replay.json",
  "spectator-telemetry.json",
  "visual-report.html",
  "spectator.html",
  "objective-scorecard.md",
  "match-story.md",
  "behavior-quality-report.json",
  "behavior-quality-report.md",
  "external-agent-feedback.md",
] as const;

export const proxyWarPublicTournamentArtifacts = [
  "leaderboard.html",
  "leaderboard.json",
  "tournament-report.md",
] as const;

export const proxyWarPublicDocs = [
  "PROXYWAR_EXTERNAL_AGENT_API.md",
  "PROXYWAR_TESTER_HANDOFF.md",
  "BETA_TESTER_GUIDE.md",
  "PROXYWAR_ASSET_AND_LICENSE_AUDIT.md",
] as const;

export const proxyWarPublicExternalAgentExamples = [
  "README.md",
  "simple-agent.mjs",
  "relay-worker.mjs",
  "starter-framework.mjs",
  "agent-policy.mjs",
  "manifest.example.json",
  "package.json",
  "launch.sh",
  "bootstrap.sh",
  ".env.example",
  "LICENSE",
  "PROXYWAR_AGENT_CARD.md",
  "AGENT_SKILL.md",
] as const;

export const proxyWarPublicLeagueArtifacts = [
  "index.html",
  "client.js",
  "data.json",
  // Social preview image published beside the league page. og:image must be
  // fetchable by external scrapers, so it has to be publicly gettable.
  "social.png",
] as const;

/**
 * Renderer asset prefixes anonymous visitors may GET so the real-client
 * replay render works without a beta session. Everything here is generic
 * client/runtime material (the repo is public); page documents stay gated.
 * "/@fs" is deliberately absent — the demo server blocks it in beta mode.
 */
export const proxyWarPublicRendererAssetPrefixes = [
  "/@vite",
  "/@id",
  "/src",
  "/node_modules",
  "/assets",
  "/_assets",
  "/resources",
  "/images",
  "/maps",
  "/lang",
  "/flags",
  "/icons",
  "/sprites",
  "/fonts",
  "/manifest.json",
  "/favicon.ico",
] as const;

export function isProxyWarPublicRendererAssetPath(pathname: string): boolean {
  return proxyWarPublicRendererAssetPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function isProxyWarPublicRunArtifact(fileName: string): boolean {
  return (proxyWarPublicRunArtifacts as readonly string[]).includes(fileName);
}

export function isProxyWarPublicLeagueArtifact(fileName: string): boolean {
  return (proxyWarPublicLeagueArtifacts as readonly string[]).includes(
    fileName,
  );
}

const proxyWarPremiereIdSource = "prem_[a-z0-9]{16,32}";
const proxyWarPremierePagePattern = new RegExp(
  `^/premiere/(${proxyWarPremiereIdSource})$`,
);
// The dedicated live-betting page: same premiere, same anonymous read
// surface and app shell as `/premiere/:id` (client-side routing decides
// which page mounts from the URL) — see BettingPremierePage.ts.
const proxyWarBettingPagePattern = new RegExp(
  `^/bet/(${proxyWarPremiereIdSource})$`,
);
const proxyWarPremiereManifestPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/manifest$`,
);
const proxyWarPremiereBootstrapPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/bootstrap$`,
);
const proxyWarPremiereChunkPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/chunks/(0|[1-9][0-9]{0,8})$`,
);
const proxyWarPremiereRevealPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/reveal$`,
);
const proxyWarPremiereCardPattern = new RegExp(
  `^/premiere/(${proxyWarPremiereIdSource})/card-v1\\.svg$`,
);
// Clip cache surface. Bucket is a bounded non-negative integer (10-turn anchor
// bucket); clip-v1 is the render-format version baked into the filename.
const proxyWarPremiereClipBucketSource = "0|[1-9][0-9]{0,8}";
const proxyWarPremiereClipFilePattern = new RegExp(
  `^/premiere/(${proxyWarPremiereIdSource})/clip-v1-(${proxyWarPremiereClipBucketSource})\\.mp4$`,
);
const proxyWarPremiereClipStatusPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/clips/(${proxyWarPremiereClipBucketSource})$`,
);
// The single durable archived clip promoted at reclamation. Distinct from the
// bucketed cache route above: this one survives after the live runtime and the
// clip cache are gone, served by the archive router from archive-v1/clips.
const proxyWarPremiereArchiveClipPattern = new RegExp(
  `^/premiere/(${proxyWarPremiereIdSource})/clip\\.mp4$`,
);
const proxyWarPremiereClipCreatePattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/clips$`,
);
const proxyWarPremierePredictionPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/predictions$`,
);
const proxyWarPremiereMarketOrderPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/market-orders$`,
);
const proxyWarPremiereMarketStatePattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/market$`,
);
/**
 * Authenticated sibling of the anonymous market-state read: returns the
 * CALLING participant's own positions (never another participant's). Same
 * guest cookie + CSRF + Origin discipline as every write route — a read
 * that returns private per-participant data is not exempt from it.
 */
const proxyWarPremiereMarketSelfPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/market/me$`,
);
const proxyWarPremiereLiveProjectionPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/live-projection$`,
);
const proxyWarPremiereReactionPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/reactions$`,
);
const proxyWarPremiereSharePattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/shares$`,
);
const proxyWarPremiereSessionPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/sessions$`,
);
const proxyWarPremiereHeartbeatPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/sessions/(sess_[a-z0-9]{16,32})/heartbeat$`,
);

export type ProxyWarPublicPremiereReadRoute =
  | { kind: "page"; premiereId: string }
  | { kind: "bootstrap"; premiereId: string }
  | { kind: "manifest"; premiereId: string }
  | { kind: "chunk"; premiereId: string; chunkIndex: number }
  | { kind: "reveal"; premiereId: string }
  | { kind: "card"; premiereId: string }
  | { kind: "clip_status"; premiereId: string; bucket: number }
  | { kind: "clip_file"; premiereId: string; bucket: number }
  | { kind: "archive_clip"; premiereId: string }
  | { kind: "market_state"; premiereId: string }
  | { kind: "market_state_self"; premiereId: string }
  | { kind: "live_projection"; premiereId: string };

export type ProxyWarPublicPremiereWriteRoute =
  | { kind: "prediction"; premiereId: string }
  | { kind: "market_order"; premiereId: string }
  | { kind: "reaction"; premiereId: string }
  | { kind: "share"; premiereId: string }
  | { kind: "session"; premiereId: string }
  | { kind: "heartbeat"; premiereId: string; sessionId: string }
  | { kind: "clip"; premiereId: string };

/**
 * Exact anonymous Premiere read surface. The private source bundle and
 * ordinary outcome-bearing replay artifacts are intentionally absent.
 */
export function matchProxyWarPublicPremiereReadPath(
  pathname: string,
): ProxyWarPublicPremiereReadRoute | null {
  const page = proxyWarPremierePagePattern.exec(pathname);
  if (page !== null) return { kind: "page", premiereId: page[1] };
  const betPage = proxyWarBettingPagePattern.exec(pathname);
  if (betPage !== null) return { kind: "page", premiereId: betPage[1] };
  const bootstrap = proxyWarPremiereBootstrapPattern.exec(pathname);
  if (bootstrap !== null) {
    return { kind: "bootstrap", premiereId: bootstrap[1] };
  }
  const manifest = proxyWarPremiereManifestPattern.exec(pathname);
  if (manifest !== null) {
    return { kind: "manifest", premiereId: manifest[1] };
  }
  const chunk = proxyWarPremiereChunkPattern.exec(pathname);
  if (chunk !== null) {
    return {
      kind: "chunk",
      premiereId: chunk[1],
      chunkIndex: Number(chunk[2]),
    };
  }
  const reveal = proxyWarPremiereRevealPattern.exec(pathname);
  if (reveal !== null) return { kind: "reveal", premiereId: reveal[1] };
  const card = proxyWarPremiereCardPattern.exec(pathname);
  if (card !== null) return { kind: "card", premiereId: card[1] };
  const clipStatus = proxyWarPremiereClipStatusPattern.exec(pathname);
  if (clipStatus !== null) {
    return {
      kind: "clip_status",
      premiereId: clipStatus[1],
      bucket: Number(clipStatus[2]),
    };
  }
  const clipFile = proxyWarPremiereClipFilePattern.exec(pathname);
  if (clipFile !== null) {
    return {
      kind: "clip_file",
      premiereId: clipFile[1],
      bucket: Number(clipFile[2]),
    };
  }
  const archiveClip = proxyWarPremiereArchiveClipPattern.exec(pathname);
  if (archiveClip !== null) {
    return { kind: "archive_clip", premiereId: archiveClip[1] };
  }
  const marketState = proxyWarPremiereMarketStatePattern.exec(pathname);
  if (marketState !== null) {
    return { kind: "market_state", premiereId: marketState[1] };
  }
  const marketSelf = proxyWarPremiereMarketSelfPattern.exec(pathname);
  if (marketSelf !== null) {
    return { kind: "market_state_self", premiereId: marketSelf[1] };
  }
  const liveProjection = proxyWarPremiereLiveProjectionPattern.exec(pathname);
  if (liveProjection !== null) {
    return { kind: "live_projection", premiereId: liveProjection[1] };
  }
  return null;
}

export function isProxyWarPublicPremiereReadPath(pathname: string): boolean {
  return matchProxyWarPublicPremiereReadPath(pathname) !== null;
}

/**
 * Exact guest write surface. Publisher/admin transitions are never anonymous.
 * Route handlers must still enforce signed participant cookies, CSRF, Origin,
 * state, idempotency, and rate limits.
 */
export function matchProxyWarPublicPremiereWritePath(
  pathname: string,
): ProxyWarPublicPremiereWriteRoute | null {
  const prediction = proxyWarPremierePredictionPattern.exec(pathname);
  if (prediction !== null) {
    return { kind: "prediction", premiereId: prediction[1] };
  }
  const marketOrder = proxyWarPremiereMarketOrderPattern.exec(pathname);
  if (marketOrder !== null) {
    return { kind: "market_order", premiereId: marketOrder[1] };
  }
  const reaction = proxyWarPremiereReactionPattern.exec(pathname);
  if (reaction !== null) {
    return { kind: "reaction", premiereId: reaction[1] };
  }
  const share = proxyWarPremiereSharePattern.exec(pathname);
  if (share !== null) return { kind: "share", premiereId: share[1] };
  const session = proxyWarPremiereSessionPattern.exec(pathname);
  if (session !== null) return { kind: "session", premiereId: session[1] };
  const heartbeat = proxyWarPremiereHeartbeatPattern.exec(pathname);
  if (heartbeat !== null) {
    return {
      kind: "heartbeat",
      premiereId: heartbeat[1],
      sessionId: heartbeat[2],
    };
  }
  const clip = proxyWarPremiereClipCreatePattern.exec(pathname);
  if (clip !== null) return { kind: "clip", premiereId: clip[1] };
  return null;
}

export function isProxyWarPublicPremiereWritePath(pathname: string): boolean {
  return matchProxyWarPublicPremiereWritePath(pathname) !== null;
}

const PROXYWAR_POINTS_LEADERBOARD_PATH = "/api/premieres/points/leaderboard";
const PROXYWAR_POINTS_DISPLAY_NAME_PATH = "/api/premieres/points/display-name";

/**
 * Cross-premiere points leaderboard read. Not `:premiereId`-scoped, so it
 * sits outside the premiere route family above and needs its own allowlist
 * entry in league-wrapper-only mode.
 */
export function isProxyWarPublicPointsReadPath(pathname: string): boolean {
  return pathname === PROXYWAR_POINTS_LEADERBOARD_PATH;
}

/** Cross-premiere points leaderboard write (setting a display name) — see {@link isProxyWarPublicPointsReadPath}. */
export function isProxyWarPublicPointsWritePath(pathname: string): boolean {
  return pathname === PROXYWAR_POINTS_DISPLAY_NAME_PATH;
}

export function proxyWarLeagueContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Paths the beta invite gate lets through anonymously: the league mirror's
 * static site (`/ai-league-runs/league/...`) and the mirror-written episode
 * bundles (`/ai-league-runs/league-<runID>/...`). Other run directories stay
 * behind the beta gate.
 */
export function isProxyWarPublicLeaguePath(pathname: string): boolean {
  if (pathname === "/league") {
    return true;
  }
  const renderMatch = /^\/ai-league-replay\/(league-[a-zA-Z0-9._:-]+)$/.exec(
    pathname,
  );
  if (renderMatch !== null) {
    return isSafeProxyWarArtifactSegment(renderMatch[1]);
  }
  const match =
    /^\/ai-league-runs\/(league(?:-[a-zA-Z0-9._:-]+)?)\/([a-zA-Z0-9._:-]+)$/.exec(
      pathname,
    );
  if (match === null) {
    return false;
  }
  const runKey = match[1];
  const artifact = match[2];
  if (!isSafeProxyWarArtifactSegment(runKey)) {
    return false;
  }
  return runKey === "league"
    ? isProxyWarPublicLeagueArtifact(artifact)
    : isProxyWarPublicRunArtifact(artifact);
}

// ---------------------------------------------------------------------------
// League-run social clips (any published match, not just premieres)
// ---------------------------------------------------------------------------

// Run keys are single safe path segments (same charset as run artifacts).
const proxyWarLeagueRunKeySource = "[a-zA-Z0-9._:-]{1,180}";
const proxyWarLeagueClipBucketSource = "0|[1-9][0-9]{0,8}";
const proxyWarLeagueClipFilePattern = new RegExp(
  `^/ai-league-runs/(${proxyWarLeagueRunKeySource})/clip-v1-(${proxyWarLeagueClipBucketSource})\\.mp4$`,
);
const proxyWarLeagueClipStatusPattern = new RegExp(
  `^/api/league-runs/(${proxyWarLeagueRunKeySource})/clips/(${proxyWarLeagueClipBucketSource})$`,
);
const proxyWarLeagueClipCreatePattern = new RegExp(
  `^/api/league-runs/(${proxyWarLeagueRunKeySource})/clips$`,
);

export type ProxyWarLeagueClipReadRoute =
  | {
      kind: "clip_status";
      runKey: string;
      bucket: number;
      publicLeague: boolean;
    }
  | {
      kind: "clip_file";
      runKey: string;
      bucket: number;
      publicLeague: boolean;
    };

export interface ProxyWarLeagueClipWriteRoute {
  kind: "clip_request";
  runKey: string;
  publicLeague: boolean;
}

/**
 * League-run clip read surface: render-status JSON and the cached mp4.
 * `publicLeague` marks mirror-published `league-*` run keys — the only keys
 * the anonymous league surface (beta gate / league wrapper) admits, exactly
 * mirroring which replay pages are public. Traversal-shaped keys never match.
 */
export function matchProxyWarLeagueClipReadPath(
  pathname: string,
): ProxyWarLeagueClipReadRoute | null {
  const status = proxyWarLeagueClipStatusPattern.exec(pathname);
  if (status !== null && isSafeProxyWarArtifactSegment(status[1])) {
    return {
      kind: "clip_status",
      runKey: status[1],
      bucket: Number(status[2]),
      publicLeague: status[1].startsWith("league-"),
    };
  }
  const file = proxyWarLeagueClipFilePattern.exec(pathname);
  if (file !== null && isSafeProxyWarArtifactSegment(file[1])) {
    return {
      kind: "clip_file",
      runKey: file[1],
      bucket: Number(file[2]),
      publicLeague: file[1].startsWith("league-"),
    };
  }
  return null;
}

/** League-run clip write surface: the render request POST. */
export function matchProxyWarLeagueClipWritePath(
  pathname: string,
): ProxyWarLeagueClipWriteRoute | null {
  const create = proxyWarLeagueClipCreatePattern.exec(pathname);
  if (create === null || !isSafeProxyWarArtifactSegment(create[1])) {
    return null;
  }
  return {
    kind: "clip_request",
    runKey: create[1],
    publicLeague: create[1].startsWith("league-"),
  };
}

const proxyWarReplayOrRunPrefixes = [
  "/ai-league-replay/",
  "/proxywar-replay/",
  "/openfront-replay/",
  "/ai-league-runs/",
  "/runs/",
] as const;

/**
 * Identifies replay-shaped paths so the wrapper can fail closed with 404
 * instead of redirecting a private or unknown source into the public league.
 */
export function isProxyWarReplayOrRunPath(pathname: string): boolean {
  return proxyWarReplayOrRunPrefixes.some(
    (prefix) => pathname.startsWith(prefix) && pathname.length > prefix.length,
  );
}

export function isProxyWarPublicTournamentArtifact(fileName: string): boolean {
  return (proxyWarPublicTournamentArtifacts as readonly string[]).includes(
    fileName,
  );
}

export function isProxyWarPublicDoc(fileName: string): boolean {
  return (proxyWarPublicDocs as readonly string[]).includes(fileName);
}

export function isProxyWarPublicExternalAgentExample(
  fileName: string,
): boolean {
  return (proxyWarPublicExternalAgentExamples as readonly string[]).includes(
    fileName,
  );
}

export function isSafeProxyWarArtifactSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    value !== "." &&
    value !== ".." &&
    value === pathBasename(value) &&
    /^[a-zA-Z0-9._:-]+$/.test(value)
  );
}

function pathBasename(value: string): string {
  return value.split(/[\\/]/).pop() ?? "";
}
