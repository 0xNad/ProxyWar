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
  "/sounds",
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
const proxyWarPremierePredictionPattern = new RegExp(
  `^/api/premieres/(${proxyWarPremiereIdSource})/predictions$`,
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
  | { kind: "card"; premiereId: string };

export type ProxyWarPublicPremiereWriteRoute =
  | { kind: "prediction"; premiereId: string }
  | { kind: "reaction"; premiereId: string }
  | { kind: "share"; premiereId: string }
  | { kind: "session"; premiereId: string }
  | { kind: "heartbeat"; premiereId: string; sessionId: string };

/**
 * Exact anonymous Premiere read surface. The private source bundle and
 * ordinary outcome-bearing replay artifacts are intentionally absent.
 */
export function matchProxyWarPublicPremiereReadPath(
  pathname: string,
): ProxyWarPublicPremiereReadRoute | null {
  const page = proxyWarPremierePagePattern.exec(pathname);
  if (page !== null) return { kind: "page", premiereId: page[1] };
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
  return null;
}

export function isProxyWarPublicPremiereWritePath(pathname: string): boolean {
  return matchProxyWarPublicPremiereWritePath(pathname) !== null;
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
