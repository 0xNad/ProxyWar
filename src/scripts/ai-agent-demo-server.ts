import { spawn, type ChildProcess } from "child_process";
import compression from "compression";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import express, { type Request, type Response } from "express";
import fs from "fs/promises";
import http from "http";
import path from "path";
import {
  loadAgentDemoHubModel,
  proxyWarAgentProtocolSchema,
  proxyWarAgentStartJson,
  renderAgentDemoHubHtml,
  renderProxyWarAdminHtml,
  renderProxyWarAgentStartHtml,
  renderProxyWarPublicHtml,
  renderProxyWarTesterDashboardHtml,
} from "../server/agents/AgentDemoHub";
import {
  buildAgentDemoJobCommand,
  loadProxyWarHouseAgentBrain,
  normalizeAgentDemoJobRequest,
  proxyWarTesterSavedRosterJobDefaults,
  type AgentDemoJobRecord,
  type AgentDemoJobRequest,
} from "../server/agents/AgentDemoServerJobs";
import { AgentRelayRateGuard } from "../server/agents/AgentRelayRateGuard";
import {
  resolveArchivedEpisodeReplayHrefs,
  resolveCoworldLeagueSummaryArchiveDir,
  restoreArchivedGameRecord,
} from "../server/agents/CoworldLeagueArtifactRetention";
import {
  resolveFeaturedMatchStateRoot,
  type FeaturedMatch,
} from "../server/agents/FeaturedMatch";
import { reconcileFeaturedMatchStore } from "../server/agents/FeaturedMatchReconcile";
import { resolveFeaturedMatchParticipantCards } from "../server/agents/FeaturedMatchParticipants";
import {
  findEventPackage,
  readEventPackageStore,
  resolveEventPackageStateRoot,
} from "../server/agents/season/EventPackage";
import {
  buildLeagueEpisodeMatchPageModel,
  buildLeagueEpisodeParticipantCards,
  findLeagueEpisodeByRequestId,
  findLeagueEpisodeRunDir,
  leagueEpisodeSpoilerSafeDescription,
  leagueEpisodeSpoilerSafeTitle,
  readCoworldLeagueEpisodesFromDataJson,
  readLeagueEpisodeDecisiveMoments,
  readLeagueEpisodeRecap,
} from "../server/agents/LeagueEpisodeMatchPage";
import {
  renderMatchShareCardSvg,
  type MatchShareCardInput,
} from "../server/agents/MatchShareCard";
import { loadIdentityRegistrySnapshot } from "../server/identity/IdentityRegistry";
import {
  buildRegistrationDraft,
  buildRegistrationIssueUrl,
  BuildRegistrationSubmissionInputSchema,
  firstFieldError,
} from "../server/identity/BuildRegistrationSubmission";
import { BuildFunnelCounters } from "../server/agents/BuildFunnelCounters";
import { AnalyticsAggregateStore } from "../server/analytics/AnalyticsAggregateStore";
import { AnalyticsIngestService } from "../server/analytics/AnalyticsIngestService";
import { AnalyticsRecentRing } from "../server/analytics/AnalyticsRecentRing";
import { applyMatchLabels, buildAnalyticsReport } from "../server/analytics/AnalyticsReport";
import { renderAnalyticsReportHtml } from "../server/analytics/AnalyticsReportPage";
import { generateEmblemSvg, deriveEmblemPalette } from "../server/identity/IdentityEmblems";
import { SlugSchema } from "../server/identity/IdentitySchemas";
import { publicFeaturedMatch } from "../server/ProxyWarPublicReadModel";
import { derivePremiereId } from "../server/replay-premiere/ReplayPremiereLoopCore";
import { gameRecordFileIsRenderable } from "../server/agents/AgentSpectatorReplay";
import {
  agentStrategyProfiles,
  type AgentStrategyProfile,
} from "../server/agents/AgentTypes";
import {
  claimAiLeagueClipCanary,
  createAiLeagueClipCanaryWriteRefusal,
  readAiLeagueClipCanary,
  validateFreshAiLeagueClipCanaryTarget,
  type AiLeagueClipCanaryRecord,
} from "../server/agents/AiLeagueClipCanary";
import {
  aiLeagueRunClipErrorBody,
  AiLeagueRunClips,
  createAiLeagueRunClipDocumentRouter,
} from "../server/agents/AiLeagueRunClips";
import {
  checkExternalAgentEndpoint,
  normalizeExternalAgentHealthCheckInput,
} from "../server/agents/ExternalAgentHealthCheck";
import { assertExternalAgentEndpointAllowed } from "../server/agents/ExternalAgentNetworkPolicy";
import {
  ExternalAgentRelayError,
  ExternalAgentRelayStore,
} from "../server/agents/ExternalAgentRelay";
import {
  normalizeExternalAgentReplaySandboxInput,
  replayExternalAgentDecision,
} from "../server/agents/ExternalAgentReplaySandbox";
import { resolveExternalAgentToken } from "../server/agents/ExternalAgentSecrets";
import type { ExternalAgentRequest } from "../server/agents/ExternalHttpAgentBrain";
import {
  buildLeaguePlayerSection,
  findLeagueEpisodeReplayInfo,
  readLeagueMirrorData,
} from "../server/agents/LeaguePlayerProfile";
import { readAgentStatsArtifact } from "../server/agents/AgentStatsArtifact";
import { readStandingsHistoryStore } from "../server/agents/CoworldLeagueStandingsHistory";
import {
  parsePlayerStrategySpec,
  PlayerStrategySpec,
} from "../server/agents/PlayerStrategySpec";
import {
  assertProxyWarActiveRosterExternalEndpointsHealthy,
  checkProxyWarActiveRosterExternalEndpoints,
  ProxyWarActiveRosterHealthError,
  proxyWarProviderTokenInput,
} from "../server/agents/ProxyWarActiveRosterHealth";
import {
  fetchAndParseProxyWarAgentCard,
  normalizeProxyWarAgentCardInput,
} from "../server/agents/ProxyWarAgentCard";
import { sendPublicArtifactFile } from "../server/agents/ProxyWarArtifactStreaming";
import {
  betaSessionCookieHeader,
  clearBetaSessionCookieHeader,
  createProxyWarBetaSessionToken,
  loadProxyWarBetaAccessConfig,
  normalizeProxyWarBetaFeedback,
  normalizeProxyWarBetaReturnTo,
  parseCookieHeader,
  renderProxyWarBetaLoginHtml,
  verifyProxyWarBetaInviteCode,
  verifyProxyWarBetaSessionToken,
} from "../server/agents/ProxyWarBetaAccess";
import {
  buildProxyWarDemoServerUrls,
  loadProxyWarDemoServerNetworkConfig,
} from "../server/agents/ProxyWarDemoServerConfig";
import type { ProxyWarDoctrine } from "../server/agents/ProxyWarNationRegistry";
import {
  defaultProxyWarNationsDir,
  deleteProxyWarNation,
  listProxyWarNations,
  saveProxyWarNation,
  syncProxyWarActiveRoster,
} from "../server/agents/ProxyWarNationRegistry";
import {
  isProxyWarPublicAccountReadPath,
  isProxyWarPublicAccountWritePath,
  isProxyWarPublicDoc,
  isProxyWarPublicExternalAgentExample,
  isProxyWarPublicLeagueArtifact,
  isProxyWarPublicLeaguePath,
  isProxyWarPublicPointsReadPath,
  isProxyWarPublicPointsWritePath,
  isProxyWarPublicPremiereReadPath,
  isProxyWarPublicPremiereWritePath,
  isProxyWarPublicRendererAssetPath,
  isProxyWarPublicRunArtifact,
  isProxyWarPublicTournamentArtifact,
  isProxyWarReplayOrRunPath,
  isSafeProxyWarArtifactSegment,
  matchProxyWarLeagueClipReadPath,
  matchProxyWarLeagueClipWritePath,
  proxyWarLeagueContentSecurityPolicy,
  proxyWarPublicRendererAssetPrefixes,
} from "../server/agents/ProxyWarPublicArtifacts";
import {
  buildProxyWarPublicReadinessReport,
  type ProxyWarPublicReadinessReport,
} from "../server/agents/ProxyWarPublicReadiness";
import {
  normalizeProxyWarRateLimitSnapshot,
  ProxyWarRateLimiter,
  type ProxyWarRateLimitSnapshot,
} from "../server/agents/ProxyWarRateLimit";
import { renderQuickStartPlayHtml } from "../server/agents/QuickStartPlayPage";
import { resolveBettingProfileServiceToken } from "../server/BettingProfileServiceAuth";
import {
  createGithubOAuthClient,
  resolveGithubOAuthConfig,
} from "../server/GithubOAuthClient";
import { createPlatformAccountRouter } from "../server/platform/PlatformAccountHttp";
import { createPlatformBuilderClaimRouter } from "../server/platform/PlatformBuilderClaimHttp";
import { resolveBuilderClaimStateRoot } from "../server/platform/PlatformBuilderClaimStore";
import { createPlatformBuilderDashboardRouter } from "../server/platform/PlatformBuilderDashboardHttp";
import { createPlatformBuilderEditRouter } from "../server/platform/PlatformBuilderEditHttp";
import { resolveBuilderEditStateRoot } from "../server/platform/PlatformBuilderEditStore";
import { createPlatformBuilderVersionRouter } from "../server/platform/PlatformBuilderVersionHttp";
import { resolveVersionReleaseStateRoot } from "../server/platform/PlatformVersionReleaseStore";
import { PlatformAccountSecurity } from "../server/platform/PlatformAccountSecurity";
import { PlatformAccountStore } from "../server/platform/PlatformAccountStore";
import { resolveCanonicalHostRedirect } from "../server/platform/PlatformCanonicalHost";
import { createPlatformGithubAuthRouter } from "../server/platform/PlatformGithubAuth";
import { PlatformGithubIdentityLinkStore } from "../server/platform/PlatformGithubIdentityLinkStore";
import { PlatformHandoffStore } from "../server/platform/PlatformHandoffStore";
import { PlatformPolicyClaimStore } from "../server/platform/PlatformPolicyClaimStore";
import { resolvePlatformReturnOrigins } from "../server/platform/PlatformReturnOrigins";
import { renderPlatformRootHtml } from "../server/platform/PlatformRootPage";
import {
  loadOrCreatePlatformHmacKey,
  PLATFORM_HMAC_HEX_ENV,
  resolvePlatformPrivateStateRoot,
} from "../server/platform/PlatformSecrets";
import {
  getAppShellContent,
  setHtmlNoCacheHeaders,
} from "../server/RenderHtml";
import {
  createBettingIdentityHandoffRouter,
  createBettingIdentityStatusRouter,
} from "../server/replay-premiere/BettingIdentityHandoff";
import { createPlatformHandoffClient } from "../server/replay-premiere/PlatformHandoffClient";
import {
  BettingPlatformAccountLinkStore,
  pointsMergerFor,
} from "../server/replay-premiere/points/BettingPlatformAccountLinkStore";
import { createBettingProfileClient } from "../server/replay-premiere/points/BettingProfileClient";
import {
  ReplayPremierePointsLedger,
  resolveReplayPremierePointsLedgerRoot,
} from "../server/replay-premiere/points/ReplayPremierePointsLedger";
import { ReplayPremiereSettlementLedger } from "../server/replay-premiere/points/ReplayPremiereSettlementLedger";
import { ReplayPremiereAnonymousWriteLimiter } from "../server/replay-premiere/ReplayPremiereAnonymousWriteLimiter";
import { ReplayPremiereArchivedClipPromoter } from "../server/replay-premiere/ReplayPremiereArchivedClipPromoter";
import { ReplayPremiereArchiveStore } from "../server/replay-premiere/ReplayPremiereArchiveIndex";
import { createReplayPremiereArchiveRouter } from "../server/replay-premiere/ReplayPremiereArchiveRouter";
import { DeterministicReplayPremiereCheckpointProjector } from "../server/replay-premiere/ReplayPremiereCheckpointProjection";
import {
  createReplayPremiereTrustedProxyAddressResolver,
  REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
} from "../server/replay-premiere/ReplayPremiereClientAddress";
import {
  createReplayPremiereClipDocumentRouter,
  replayPremiereClipCacheDir,
  ReplayPremiereClips,
  ReplayPremiereRevealAutoClip,
} from "../server/replay-premiere/ReplayPremiereClips";
import {
  PREMIERE_ID_PATTERN,
  premiereClipRepresentativeAnchorTurn,
} from "../server/replay-premiere/ReplayPremiereContracts";
import {
  ReplayPremiereError,
  toPublicReplayPremiereFailure,
} from "../server/replay-premiere/ReplayPremiereErrors";
import { ReplayPremiereGuestSecurity } from "../server/replay-premiere/ReplayPremiereGuestSecurity";
import {
  createReplayPremiereRouter,
  formatReplayPremiereHttpOperatorError,
  ReplayPremiereHttpRegistry,
  requestSecurityHeaders,
} from "../server/replay-premiere/ReplayPremiereHttp";
import type { ReplayPremiereSettlementPointsRecorder } from "../server/replay-premiere/ReplayPremiereInteractions";
import {
  createReplayPremierePublicPageRouter,
  escapeHtml,
  nonceInlineScripts,
  pageContentSecurityPolicyWithNonce,
  stripShellSocialMetadata,
} from "../server/replay-premiere/ReplayPremierePublicPage";
import { ReplayPremiereRuntimeRegistry } from "../server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import {
  loadOrCreateReplayPremiereGuestHmacKey,
  REPLAY_PREMIERE_HMAC_HEX_ENV,
  resolveReplayPremierePrivateStateRoot,
} from "../server/replay-premiere/ReplayPremiereSecrets";
import { startReplayPremiereProduction } from "../server/replay-premiere/ReplayPremiereStartup";
import { loadReplayPremiereReclamationExclusions } from "../server/replay-premiere/ReplayPremiereTerminalReclamation";
import { DeterministicSyntheticCrowdTerritoryProjector } from "../server/replay-premiere/wagering/simulation";
import { applyStaticAssetCacheControl } from "../server/StaticAssetCache";

const app = express();
// Gzip/brotli-compresses every response this app sends, including the
// premiere replay/live-projection JSON API (`ReplayPremiereHttp.ts`'s
// `sendJson`), which is otherwise sent uncompressed. Real Turn-payload JSON
// (repetitive keys, small numeric deltas) compresses well; this is a pure
// transport-layer change — the exact same bytes are hashed/verified after
// `fetch()` transparently decompresses, so it does not touch integrity,
// embargo, or ledger logic. See `compression()` in `src/server/Worker.ts`
// for the same pattern already in use elsewhere in this codebase.
app.use(compression());
const networkConfig = loadProxyWarDemoServerNetworkConfig();
const serverUrls = buildProxyWarDemoServerUrls(networkConfig);
const port = networkConfig.port;
const host = networkConfig.host;
const replayPremierePublicOrigin = new URL(
  serverUrls.publicUrl ?? serverUrls.localUrl,
).origin;
export const replayPremierePrivateStateRoot =
  resolveReplayPremierePrivateStateRoot();
const replayPremiereAnonymousWriteLimiter =
  new ReplayPremiereAnonymousWriteLimiter();
export const replayPremiereHttpRegistry = new ReplayPremiereHttpRegistry(
  replayPremiereAnonymousWriteLimiter.admit,
);
const rendererPort = Number(process.env.AI_LEAGUE_RENDERER_PORT ?? "9000");
const rendererListenHost = process.env.AI_LEAGUE_RENDERER_HOST ?? "127.0.0.1";
const rendererBaseUrl =
  process.env.AI_LEAGUE_RENDERER_BASE_URL ?? `http://127.0.0.1:${rendererPort}`;
const staticRootDir = path.join(process.cwd(), "static");
const configuredArtifactsRootDir = firstConfiguredEnv(
  "PROXYWAR_ARTIFACTS_ROOT",
);
const artifactsRootDir =
  configuredArtifactsRootDir === undefined
    ? path.join(process.cwd(), "artifacts")
    : path.resolve(configuredArtifactsRootDir);
const runsRootDir = path.join(artifactsRootDir, "ai-league-runs");
// Full-replay-retention fix (2026-08-06) — see
// `CoworldLeagueArtifactRetention.ts`'s `resolveArchivedEpisodeReplayHrefs`/
// `restoreArchivedGameRecord` for what this durable, indefinitely-retained
// directory backs.
const summaryArchiveDir = resolveCoworldLeagueSummaryArchiveDir(artifactsRootDir);
const publicReplayRenderabilityCache = new Map<
  string,
  { fingerprint: string; verdict: Promise<boolean> }
>();
const publicReplayRenderabilityCacheMaxEntries = 256;
const tournamentsRootDir = path.join(artifactsRootDir, "ai-league-tournaments");
const evaluationsRootDir = path.join(artifactsRootDir, "ai-league-evals");
const jobsRootDir = path.join(artifactsRootDir, "ai-league-demo-jobs");
const jobsPath = path.join(jobsRootDir, "jobs.json");
const configuredNationsRootDir = firstConfiguredEnv("PROXYWAR_NATIONS_DIR");
const nationsRootDir =
  configuredNationsRootDir !== undefined && configuredNationsRootDir !== ""
    ? path.resolve(configuredNationsRootDir)
    : defaultProxyWarNationsDir;
const docsRootDir = path.join(process.cwd(), "docs");
const externalAgentExampleRootDir = path.join(
  process.cwd(),
  "examples",
  "external-agent",
);
const platformEnabled = envFlag("PROXYWAR_PLATFORM_ENABLED");
// Where THIS process's own account cookie/CSRF are scoped to — see
// `PlatformAccountSecurity`'s doc. Deliberately reuses this origin's own
// public URL, never a peer's: a child app never gets an
// `expectedOrigin`-satisfying platform cookie, and vice versa.
const configuredPlatformOrigin = firstConfiguredEnv("PROXYWAR_PLATFORM_ORIGIN");
/**
 * The league/replay CSP, in ONE place — `connect-src 'self'`, no per-page
 * override. Previously widened to also allow the platform account origin
 * (so a signed-in viewer's replay camera could default to their own
 * claimed agent via a cross-origin `/api/account/pov-claims` fetch); that
 * feature was removed, so every league surface is back to a closed CSP.
 * Routing every call site through one helper is what would stop a future
 * page from omitting a real widening need, if one is ever added again.
 */
const leagueContentSecurityPolicy = (): string =>
  proxyWarLeagueContentSecurityPolicy();
// The account authority answers on exactly ONE hostname. After the apex
// cutover `app.proxywar.xyz` still reaches this process through the tunnel,
// and simply serving it would hand the visitor a second host-only session
// whose every write then 403s with `origin_rejected` — see
// `PlatformCanonicalHost` for why that shape is worse than a hard failure.
// Mounted before any route so a deep link survives the bounce, and platform
// mode only: a betting/league process has its own origin and must not redirect
// anything. 302, not 301 — this is a compatibility shim for a hostname that
// just moved once already, and a permanent redirect is cached indefinitely by
// browsers that would then have to be told twice if it moves again.
if (platformEnabled && configuredPlatformOrigin !== undefined) {
  app.use((req, res, next) => {
    const canonicalRedirect = resolveCanonicalHostRedirect({
      canonicalOrigin: configuredPlatformOrigin,
      host: req.headers.host,
      method: req.method,
      originalUrl: req.originalUrl,
    });
    if (canonicalRedirect === null) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.redirect(302, canonicalRedirect);
  });
}
// Sibling origins this process links out to from its own homepage nav
// (`PlatformRootPage`, platform mode only) and — for `bettingOrigin` only
// — calls server-to-server for a linked bettor's public points stats (see
// `BettingProfileClient`). Hardcoded defaults match the other hardcoded
// `beta.proxywar.xyz` references already in this file (e.g. the
// agent-start bootstrap commands below); overridable for tests/dev.
const bettingOrigin =
  firstConfiguredEnv("PROXYWAR_BETTING_ORIGIN") ?? "https://bet.proxywar.xyz";
const platformLeagueHomeUrl =
  firstConfiguredEnv("PROXYWAR_LEAGUE_HOME_URL") ??
  "https://beta.proxywar.xyz/league";
// Replays and the Market used to be, deliberately, the same page (betting's
// `/bet` resolved to whichever premiere was live, and the homepage's
// Replays card pointed there too) — that decision is SUPERSEDED as of
// `b9ca3238a` (2026-08-02, "point Replays card to watch URL instead of
// betting URL"). A visitor clicking "Replays" wants the non-wagering
// archive, not a page whose whole point is a live wagering panel; sharing
// one URL between the two cards meant "Replays" silently dropped a
// stranger onto the betting surface with no way to tell the cards apart
// by where they actually went. The homepage still gives them separate
// cards with separate framing (spectate vs. trade) because that IS how a
// stranger decides which one they want — see `platformReplaysHomeUrl`
// below (now `beta.proxywar.xyz/watch`) and `platformMarketHomeUrl`
// (still `${bettingOrigin}/bet`).
const platformMarketHomeUrl =
  firstConfiguredEnv("PROXYWAR_MARKET_HOME_URL") ?? `${bettingOrigin}/bet`;
const platformReplaysHomeUrl =
  firstConfiguredEnv("PROXYWAR_REPLAYS_HOME_URL") ?? "https://beta.proxywar.xyz/watch";
const replayPremiereGuestSecurity = new ReplayPremiereGuestSecurity({
  hmacKey: await loadOrCreateReplayPremiereGuestHmacKey({
    privateStateRoot: replayPremierePrivateStateRoot,
    servedRoots: [
      process.cwd(),
      staticRootDir,
      artifactsRootDir,
      docsRootDir,
      externalAgentExampleRootDir,
    ],
    configuredHex: firstConfiguredEnv(REPLAY_PREMIERE_HMAC_HEX_ENV),
  }),
  expectedOrigin: replayPremierePublicOrigin,
  production: replayPremierePublicOrigin.startsWith("https://"),
});
// Durable, cross-premiere points ledger and leaderboard — keyed by the same
// signed guest cookie identity as bankroll/positions, but stored outside
// `replayPremierePrivateStateRoot` (default a distinct
// `storage/points-ledger` root, override via PROXYWAR_POINTS_LEDGER_ROOT) so
// cycle-premiere.sh wiping the premiere state root never touches it. See
// `ReplayPremierePointsLedger`'s doc comment for the points-formula
// reasoning.
const replayPremierePointsLedgerRoot = resolveReplayPremierePointsLedgerRoot();
export const replayPremierePointsLedger = await ReplayPremierePointsLedger.open(
  replayPremierePointsLedgerRoot,
);
// Durable "who won" settlement ledger — beside the points ledger, same
// root, same atomic write-temp-then-rename convention, its own file (the
// exact precedent `BettingPlatformAccountLinkStore` already set for a
// second store sharing this root). Survives `cycle-premiere.sh`'s state-
// root wipe for the same reason the points ledger does: this root is
// outside it. See `ReplayPremiereSettlementLedger`'s doc comment.
export const replayPremiereSettlementLedger =
  await ReplayPremiereSettlementLedger.open(replayPremierePointsLedgerRoot);
// Betting's link to the platform account authority — proxywar.xyz is
// the sole account/session authority now (see the platform build's
// contract), so betting never talks to GitHub directly and never writes a
// display name; it only LEARNS a platformAccountId + cached display name
// once a handoff redemption succeeds (`BettingIdentityHandoff.ts`), and
// caches it here. Beside the points ledger: same root, same atomic
// write-temp-then-rename convention, its own file
// (`platform-account-links-v1.json`).
export const bettingPlatformAccountLinkStore =
  await BettingPlatformAccountLinkStore.open(
    replayPremierePointsLedgerRoot,
    pointsMergerFor(replayPremierePointsLedger),
  );
// GitHub sign-in is cleanly absent — no button client-side, no mounted
// route below — unless BOTH secrets are configured. See
// `resolveGithubOAuthConfig` and `RUNBOOK.md` for the exact
// app-registration recipe. One OAuth app, read once here, used ONLY by
// the platform's own router (mounted further below, gated on
// `platformEnabled`) — betting never sees these values.
const githubOAuthConfig = await resolveGithubOAuthConfig();
const githubOAuthClient =
  githubOAuthConfig === null
    ? null
    : createGithubOAuthClient(githubOAuthConfig);
// Wraps the raw ledger so a settlement always credits the CURRENT canonical
// identity, even from a browser whose guest cookie was merged away by a
// platform-account link completed on a different device.
// `resolveCanonicalParticipantId` is a local file lookup, never a network
// call to the platform — this can never block, delay, or fail a trade
// because the platform is unreachable (see the contract: "Platform down:
// betting trades, settles and ranks normally").
const replayPremierePointsRecorder: ReplayPremiereSettlementPointsRecorder = {
  async recordPremiereSettlement(premiereId, settlements) {
    const resolved = await Promise.all(
      settlements.map(async (settlement) => ({
        ...settlement,
        participantId:
          await bettingPlatformAccountLinkStore.resolveCanonicalParticipantId(
            settlement.participantId,
          ),
      })),
    );
    await replayPremierePointsLedger.recordPremiereSettlement(
      premiereId,
      resolved,
    );
  },
};
export const replayPremiereRuntimeRegistry =
  new ReplayPremiereRuntimeRegistry();
// Durable archive of reclaimed premieres: keeps `/premiere/<id>` resolvable
// after the bulk is deleted and across restarts, and drives startup journal
// compaction. Its pointer index is deduped/compacted on open.
export const replayPremiereArchiveStore = await ReplayPremiereArchiveStore.open(
  {
    privateStateRoot: replayPremierePrivateStateRoot,
  },
);
const replayPremiereArchivedClipPromoter =
  new ReplayPremiereArchivedClipPromoter({
    privateStateRoot: replayPremierePrivateStateRoot,
    archiveStore: replayPremiereArchiveStore,
    logger: (message) => console.log(`[premiere-archived-clips] ${message}`),
  });

try {
  await replayPremiereArchivedClipPromoter.repairOrphanedTemporaryFiles();
} catch (error) {
  console.error(
    `Replay Premiere archived clip temp repair degraded: ${
      error instanceof ReplayPremiereError
        ? error.operatorCode
        : error instanceof Error
          ? error.message
          : String(error)
    }`,
  );
}
// Premiere ids that must never be reclaimed (release-proof premieres). Sourced
// from PROXYWAR_PREMIERE_RECLAIM_EXCLUDE and the reclaim-exclude.txt pin file.
const replayPremiereReclaimExclusions =
  await loadReplayPremiereReclamationExclusions({
    privateStateRoot: replayPremierePrivateStateRoot,
  });
// Reveal observations feed the automatic default-clip render. The scheduler is
// constructed after the clip service below; observations that fire during
// startup recovery (a premiere recovered already revealed) are buffered
// (bounded) and replayed once the scheduler exists.
let replayPremiereRevealAutoClip: ReplayPremiereRevealAutoClip | null = null;
// Constructed after bounded Premiere recovery. The reclamation callback below
// closes over this binding so later sweeps fence and drain real clip work;
// during startup itself it is still null, when no clip route or worker exists.
let replayPremiereClips: ReplayPremiereClips | null = null;
const bufferedRevealObservations: string[] = [];
const notifyPremiereRevealed = (premiereId: string): void => {
  if (replayPremiereRevealAutoClip !== null) {
    replayPremiereRevealAutoClip.onPremiereRevealed(premiereId);
  } else if (bufferedRevealObservations.length < 64) {
    bufferedRevealObservations.push(premiereId);
  }
};
// Premiere recovery must never take the whole beta down: the league, demo,
// and replay surfaces do not depend on it. 2026-07-22 round-649 outage: an
// over-ceiling catalog AGGREGATE threw json_complexity_exceeded out of this
// top-level await and crash-looped every boot (public 502s, ~10 min) until
// the admission was quarantined by hand. On failure, premieres are disabled
// for this process (premiere routes 404) and everything else serves.
const replayPremiereProduction = await startReplayPremiereProduction({
  privateStateRoot: replayPremierePrivateStateRoot,
  servedRoots: [
    process.cwd(),
    staticRootDir,
    artifactsRootDir,
    docsRootDir,
    externalAgentExampleRootDir,
  ],
  publicOrigin: replayPremierePublicOrigin,
  security: replayPremiereGuestSecurity,
  httpRegistry: replayPremiereHttpRegistry,
  runtimeRegistry: replayPremiereRuntimeRegistry,
  checkpointProjector: new DeterministicReplayPremiereCheckpointProjector(
    path.join(process.cwd(), "resources", "maps"),
  ),
  territoryProjector: new DeterministicSyntheticCrowdTerritoryProjector(
    path.join(process.cwd(), "resources", "maps"),
  ),
  archiveStore: replayPremiereArchiveStore,
  archivedClipPromoter: replayPremiereArchivedClipPromoter,
  reclamationExcludedPremiereIds: replayPremiereReclaimExclusions,
  fenceClipWritesAndDrain: (premiereId) =>
    replayPremiereClips?.fenceWritesAndDrain(premiereId) ?? Promise.resolve(),
  onPremiereRevealed: notifyPremiereRevealed,
  // Leave bounded launch headroom for the remaining initialization and bind.
  maxStartupMs: 8_000,
  // Play money only, off by default. PROXYWAR_WAGERING_ENABLED=1 turns on
  // the continuous LMSR prediction market for the whole live premiere (not
  // checkpoint-gated) for local/dev testing.
  wageringEnabled: envFlag("PROXYWAR_WAGERING_ENABLED"),
  pointsLedger: replayPremierePointsRecorder,
  settlementLedger: replayPremiereSettlementLedger,
  // Deterministic, seeded synthetic bettors that keep a thin local/dev
  // market legible for demos/tester sessions. Requires PROXYWAR_WAGERING_ENABLED=1
  // too. Off by default, never for production.
  syntheticCrowdEnabled: envFlag("PROXYWAR_SYNTHETIC_CROWD_ENABLED"),
  onDiagnostic: (diagnostic) => {
    // Deferred fresh-admission lane, orphan-reclamation, and archived-clip
    // promotion events are progress, not rejections; keep the historical
    // "recovery rejected" wording for real rejections so existing operator
    // greps stay valid.
    const line = diagnostic.operatorCode.startsWith("deferred_assembly")
      ? `Replay Premiere deferred recovery ${diagnostic.target}: ${diagnostic.operatorCode}`
      : diagnostic.operatorCode.startsWith("orphan_")
        ? `Replay Premiere orphan reclamation ${diagnostic.target}: ${diagnostic.operatorCode}`
        : diagnostic.operatorCode.startsWith("archived_clip")
          ? `Replay Premiere archived clips: ${diagnostic.operatorCode}`
          : `Replay Premiere recovery rejected ${diagnostic.target}: ${diagnostic.operatorCode}`;
    console.error(line);
  },
}).catch((error: unknown) => {
  console.error(
    `Replay Premiere production recovery failed; premieres disabled for this process: ${
      error instanceof ReplayPremiereError
        ? error.operatorCode
        : error instanceof Error
          ? error.message
          : String(error)
    }`,
  );
  return null;
});
// Replay social-clip services are cache, never event-store evidence. Every
// generation surface defaults OFF. PROXYWAR_CLIPS_ENABLED is the master
// emergency gate; each surface additionally requires its own explicit flag.
// Construction is best-effort: if the license strings (or index rebuild) fail
// — e.g. a minimal test checkout with no resources/lang/en.json — clips are
// disabled with a warning rather than crashing the whole server.
const replayClipsMasterRequested = envFlag("PROXYWAR_CLIPS_ENABLED");
const replayPremiereClipsRequested = envFlag("PROXYWAR_PREMIERE_CLIPS_ENABLED");
const aiLeagueRunClipsRequested = envFlag("PROXYWAR_LEAGUE_CLIPS_ENABLED");
const aiLeagueClipCanaryState = await readAiLeagueClipCanary({
  privateStateRoot: replayPremierePrivateStateRoot,
});
console.error(
  `[league-clips] canary ${aiLeagueClipCanaryState.diagnostic.code}`,
);
const aiLeagueClipCanaryConfigurationConflict =
  (aiLeagueClipCanaryState.claimable || aiLeagueClipCanaryState.readEnabled) &&
  (replayPremiereClipsRequested || aiLeagueRunClipsRequested);
if (aiLeagueClipCanaryConfigurationConflict) {
  console.error("[league-clips] canary clip_canary_global_flag_conflict");
}
const replayClipsMasterEnabled =
  replayClipsMasterRequested && !aiLeagueClipCanaryConfigurationConflict;
const replayPremiereClipsEnabled =
  replayClipsMasterEnabled && replayPremiereClipsRequested;
if (replayPremiereClipsEnabled) {
  try {
    replayPremiereClips = new ReplayPremiereClips({
      clipsRoot: replayPremiereClipCacheDir(replayPremierePrivateStateRoot),
      sourceBundleRoot: replayPremierePrivateStateRoot,
      staticDir: staticRootDir,
      workerModulePath: path.join(
        process.cwd(),
        "src",
        "scripts",
        "replay-premiere-clip-worker.ts",
      ),
      publicOrigin: replayPremierePublicOrigin,
      licenseStrings: await loadReplayPremiereClipLicenseStrings(),
      storageStatePath: path.join(
        path.dirname(replayPremierePrivateStateRoot),
        "state.json",
      ),
      clipFfmpegBin: firstConfiguredEnv("PROXYWAR_CLIP_FFMPEG_BIN"),
      clipChromeBin: firstConfiguredEnv("PROXYWAR_CLIP_CHROME_BIN"),
      logger: (message) => console.log(`[premiere-clips] ${message}`),
    });
    // Rebuild the disk-scan cache index before binding; a partial cache costs
    // only render time, so a rebuild failure is logged, not fatal.
    await replayPremiereClips.rebuildIndex().catch((error: unknown) => {
      console.error(
        `Replay Premiere clip index rebuild failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  } catch (error) {
    replayPremiereClips = null;
    console.error(
      `Replay Premiere clips disabled: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
// Automatic default clip at reveal: every revealed premiere gets ONE scheduled
// render (plus one bounded retry) of its reveal-payoff moment, so the durable
// archived page has a clip even if nobody clicked render during the short
// revealed window. Best-effort; disabled together with the clip service.
if (replayPremiereClips !== null) {
  replayPremiereRevealAutoClip = new ReplayPremiereRevealAutoClip({
    clips: replayPremiereClips,
    resolveRuntime: (premiereId) =>
      replayPremiereHttpRegistry.get(premiereId)?.runtime ?? null,
    logger: (message) => console.log(`[premiere-clips] auto ${message}`),
  });
  for (const premiereId of bufferedRevealObservations.splice(0)) {
    replayPremiereRevealAutoClip.onPremiereRevealed(premiereId);
  }
} else {
  bufferedRevealObservations.length = 0;
}
// League-run clips: the same watermarked social-clip pipeline for EVERY
// published match, rendered from the run's own game-record.json. Separate
// cache tree (league-clips-v1) so premiere and run clips never collide.
// Has an independent effective gate under the master emergency switch.
let aiLeagueRunClips: AiLeagueRunClips | null = null;
const aiLeagueRunClipsEnabled =
  replayClipsMasterEnabled && aiLeagueRunClipsRequested;
const aiLeagueClipCanaryRecord: AiLeagueClipCanaryRecord | null =
  replayClipsMasterRequested &&
  !aiLeagueClipCanaryConfigurationConflict &&
  (aiLeagueClipCanaryState.claimable || aiLeagueClipCanaryState.readEnabled)
    ? aiLeagueClipCanaryState.record
    : null;
if (aiLeagueClipCanaryState.claimable && !replayClipsMasterRequested) {
  console.error("[league-clips] canary clip_canary_master_disabled");
}
let aiLeagueClipCanaryActionAuthorized =
  aiLeagueClipCanaryRecord?.lifecycle === "claimed";
let aiLeagueClipCanaryValidatedSource: Awaited<
  ReturnType<AiLeagueRunClips["resolveRetainedRunSource"]>
> | null = null;
if (aiLeagueRunClipsEnabled || aiLeagueClipCanaryRecord !== null) {
  try {
    aiLeagueRunClips = new AiLeagueRunClips({
      runsRootDir,
      clipsRoot: path.join(replayPremierePrivateStateRoot, "league-clips-v1"),
      staticDir: staticRootDir,
      workerModulePath: path.join(
        process.cwd(),
        "src",
        "scripts",
        "replay-premiere-clip-worker.ts",
      ),
      publicOrigin: replayPremierePublicOrigin,
      licenseStrings: await loadReplayPremiereClipLicenseStrings(),
      storageStatePath: path.join(
        path.dirname(replayPremierePrivateStateRoot),
        "state.json",
      ),
      clipFfmpegBin: firstConfiguredEnv("PROXYWAR_CLIP_FFMPEG_BIN"),
      clipChromeBin: firstConfiguredEnv("PROXYWAR_CLIP_CHROME_BIN"),
      logger: (message) => console.log(`[league-clips] ${message}`),
      shouldRepairRunClipOnIndexRebuild: (runKey) =>
        replayPremiereArchiveStore.revealPublicRatedCoworldPointersForRunKey(
          runKey,
        ).length > 0,
      canaryScope:
        aiLeagueClipCanaryRecord === null
          ? undefined
          : {
              runKey: aiLeagueClipCanaryRecord.runKey,
              bucket: aiLeagueClipCanaryRecord.bucket,
              sourceReplaySha256: aiLeagueClipCanaryRecord.sourceReplaySha256,
              expiresAt: aiLeagueClipCanaryRecord.expiresAt,
              isAuthorized: () => aiLeagueClipCanaryActionAuthorized,
            },
      onRunClipReady: async (ready) => {
        if (
          aiLeagueClipCanaryRecord !== null &&
          !aiLeagueClipCanaryActionAuthorized
        ) {
          return;
        }
        await replayPremiereArchivedClipPromoter.promoteRatedCoworldRunClip(
          ready,
        );
      },
    });
    await aiLeagueRunClips.rebuildIndex().catch((error: unknown) => {
      console.error(
        `League run clip index rebuild failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    if (aiLeagueClipCanaryRecord !== null) {
      aiLeagueClipCanaryValidatedSource =
        await aiLeagueRunClips.resolveRetainedRunSource(
          aiLeagueClipCanaryRecord.runKey,
        );
      const representativeAnchorTurn = premiereClipRepresentativeAnchorTurn(
        aiLeagueClipCanaryRecord.bucket,
      );
      if (
        aiLeagueClipCanaryValidatedSource === null ||
        aiLeagueClipCanaryValidatedSource.sourceReplaySha256 !==
          aiLeagueClipCanaryRecord.sourceReplaySha256 ||
        representativeAnchorTurn >
          aiLeagueClipCanaryValidatedSource.renderableThroughTurn
      ) {
        throw new Error("clip_canary_source_validation_failed");
      }
      if (aiLeagueClipCanaryRecord.lifecycle === "armed") {
        await validateFreshAiLeagueClipCanaryTarget({
          privateStateRoot: replayPremierePrivateStateRoot,
          runsRoot: runsRootDir,
          target: aiLeagueClipCanaryRecord,
          archiveStore: replayPremiereArchiveStore,
        });
      }
    }
  } catch (error) {
    await aiLeagueRunClips?.close().catch(() => undefined);
    aiLeagueRunClips = null;
    aiLeagueClipCanaryValidatedSource = null;
    console.error(
      `League run clips disabled: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
const betaAccess = loadProxyWarBetaAccessConfig();
const betaFeedbackRootDir = path.join(
  artifactsRootDir,
  "proxywar",
  "beta-feedback",
);
const betaFeedbackPath = path.join(betaFeedbackRootDir, "feedback.jsonl");
const rateLimitStatePath = path.join(
  artifactsRootDir,
  "proxywar",
  "rate-limits.json",
);
const jobs = new Map<string, AgentDemoJobRecord>(
  (await readJobHistory()).map((job) => [job.jobID, job]),
);
const queuedJobIDs: string[] = [];
let runningJobID: string | null = null;
let runningChild: ChildProcess | null = null;
const maxQueuedJobs = positiveInt(
  firstConfiguredEnv("PROXYWAR_MAX_QUEUED_JOBS"),
  3,
);
const rateLimiter = new ProxyWarRateLimiter({
  windowMs: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_WINDOW_MS"),
    60_000,
  ),
  initialSnapshot: await readRateLimitState(),
});
const rateLimits = {
  betaLogin: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_BETA_LOGIN"),
    20,
  ),
  jobs: positiveInt(firstConfiguredEnv("PROXYWAR_RATE_LIMIT_JOBS"), 12),
  nations: positiveInt(firstConfiguredEnv("PROXYWAR_RATE_LIMIT_NATIONS"), 30),
  externalCheck: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_EXTERNAL_CHECK"),
    60,
  ),
  feedback: positiveInt(firstConfiguredEnv("PROXYWAR_RATE_LIMIT_FEEDBACK"), 30),
  // League-run clip render requests (the clip service's own render quotas and
  // queue bound the actual work; this only caps request spam per IP).
  leagueClips: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_LEAGUE_CLIPS"),
    20,
  ),
  // Managed-relay routes are polled by automated workers (~1 long poll / 25s
  // steady, faster during active play), so this scope is far more generous than
  // the human-initiated scopes above. It only caps tunnelled external callers;
  // loopback traffic (the game subprocess, local self-tests) is exempt.
  agentRelay: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_AGENT_RELAY"),
    600,
  ),
  // `/build`'s emblem preview + registration-submission form; generous
  // since it's read-mostly/local-compute, but still capped against spam.
  build: positiveInt(firstConfiguredEnv("PROXYWAR_RATE_LIMIT_BUILD"), 40),
  // Product-analytics ingest (`/api/analytics/events`) — one call per
  // client flush (interval + pagehide), each carrying a small batch; this
  // caps request spam per IP, independent of the ingest service's own
  // per-visitor-id limiter (see AnalyticsIngestService.ts).
  analytics: positiveInt(firstConfiguredEnv("PROXYWAR_RATE_LIMIT_ANALYTICS"), 120),
};
const buildFunnelCounters = new BuildFunnelCounters(artifactsRootDir);
const analyticsAggregateStore = new AnalyticsAggregateStore(artifactsRootDir);
const analyticsRecentRing = new AnalyticsRecentRing(artifactsRootDir);
const analyticsIngestService = new AnalyticsIngestService(
  analyticsAggregateStore,
  analyticsRecentRing,
);
const betaAdminEnabled = envFlag("PROXYWAR_BETA_ADMIN_ENABLED");
const allowPrivateAgentEndpoints = envFlag(
  "PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS",
);
const houseAgentBrain = loadProxyWarHouseAgentBrain(process.env);
const agentRelay = new ExternalAgentRelayStore({
  sessionTtlMs: positiveInt(
    process.env.PROXYWAR_AGENT_RELAY_SESSION_TTL_MS,
    2 * 60 * 60 * 1_000,
  ),
  requestTimeoutMs: positiveInt(
    process.env.PROXYWAR_AGENT_RELAY_DECISION_TIMEOUT_MS,
    120_000,
  ),
  redeliveryMs: positiveInt(
    process.env.PROXYWAR_AGENT_RELAY_REDELIVERY_MS,
    5_000,
  ),
});
const relayActiveIdleMs = positiveInt(
  process.env.PROXYWAR_AGENT_RELAY_ACTIVE_IDLE_MS,
  90_000,
);
const relayMaxConcurrentPolls = positiveInt(
  process.env.PROXYWAR_AGENT_RELAY_MAX_CONCURRENT_POLLS,
  8,
);
// DoS guard for the pre-gate managed-relay routes: per-IP request-rate limit
// plus a per-IP cap on concurrently-held long polls (the `poll` route holds a
// socket up to 30s). Trusted loopback callers are exempt so the game subprocess
// and local tooling are never throttled.
const agentRelayGuard = new AgentRelayRateGuard<Request>({
  rateLimiter,
  requestsPerWindow: rateLimits.agentRelay,
  maxConcurrentPolls: relayMaxConcurrentPolls,
  key: rateLimitKey,
  isTrusted: isTrustedLocalRelayRequest,
  onConsume: () => {
    void persistRateLimitState();
  },
});
const interruptedJobsReset = resetInterruptedJobs();
if (interruptedJobsReset > 0) {
  await persistJobs();
}

// Public, spoiler-neutral process capability. Both clients fail closed until
// this strict response confirms that their corresponding generation service
// was actually constructed; durable archived clip documents are independent.
app.get("/api/clip-capabilities", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).json({
    schemaVersion: 1,
    premiereGenerationEnabled:
      replayPremiereClipsEnabled && replayPremiereClips !== null,
    leagueGenerationEnabled:
      aiLeagueRunClipsEnabled && aiLeagueRunClips !== null,
  });
});

// Mount before the generic parser so Premiere's stricter 32 KiB body ceiling
// applies to both declared-length and chunked requests.
// Gated on wagering rather than on middleware ordering: these must sit ABOVE
// createReplayPremiereRouter (which claims all of /api/premieres and 404s an
// unknown id), but that is also above the league-wrapper and beta gates. A
// wagering check is the precise condition anyway - points only exist where a
// market does, so beta (no PROXYWAR_WAGERING_ENABLED) serves 404 here.
const pointsRoutesEnabled = envFlag("PROXYWAR_WAGERING_ENABLED");

// Cross-premiere points leaderboard. Mounted after the league-wrapper-only
// and beta gates. League-wrapper-only mode explicitly allowlists the two
// exact paths below (`isProxyWarPublicPointsReadPath`/`WritePath`) so this
// surface reaches the betting demo (`bet.proxywar.xyz`); the beta gate does
// NOT allowlist them, so this is unreachable in beta mode (`PROXYWAR_BETA_
// ENABLED=1`, the real-participant league) — deliberately: points/leaderboard
// is a betting-demo feature, not a beta-league one. See
// `ReplayPremierePointsLedger` for the durable-storage and points-formula
// reasoning; `bootstrapRead` mints/reuses the same signed guest cookie the
// premiere session flow uses, so a viewer's identity here is the SAME
// identity that owns their bankroll and positions.
function sendReplayPremiereFailure(res: Response, error: unknown): void {
  const status = error instanceof ReplayPremiereError ? error.httpStatus : 503;
  if (error instanceof ReplayPremiereError) {
    console.error(formatReplayPremiereHttpOperatorError(error));
  } else {
    console.error(
      `Points route failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  res.status(status).json(toPublicReplayPremiereFailure(error));
}
/** Attaches the platform-linked display name (or `null`, when unlinked) to leaderboard/viewer entries in one bulk lookup — never per-row. `platformAccountId` is non-null ONLY for a genuinely linked account (see `BettingPlatformAccountLinkStore.describeMany`), the anti-spoof primitive `/api/players/:name` below relies on. */
async function decoratePointsEntries<T extends { participantId: string }>(
  entries: readonly T[],
): Promise<
  Array<T & { displayName: string | null; platformAccountId: string | null }>
> {
  const described = await bettingPlatformAccountLinkStore.describeMany(
    entries.map((entry) => entry.participantId),
  );
  return entries.map((entry) => {
    const link = described.get(entry.participantId);
    return {
      ...entry,
      displayName: link?.displayName ?? null,
      platformAccountId: link?.platformAccountId ?? null,
    };
  });
}
app.get("/api/premieres/points/leaderboard", async (req, res) => {
  if (!pointsRoutesEnabled) {
    res.status(404).json({ error: { code: "PREMIERE_UNAVAILABLE" } });
    return;
  }
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const guest = replayPremiereGuestSecurity.bootstrapRead(
      requestSecurityHeaders(req),
    );
    if (guest.setCookie !== null) {
      res.setHeader("Set-Cookie", guest.setCookie);
    }
    // Resolve through any platform-account merge first: a browser whose
    // guest cookie was merged away into a canonical identity still finds
    // ITSELF here — never an empty orphaned row (see
    // `BettingPlatformAccountLinkStore`).
    const viewerParticipantId =
      await bettingPlatformAccountLinkStore.resolveCanonicalParticipantId(
        guest.participant.participantId,
      );
    const leaderboard = await replayPremierePointsLedger.readLeaderboard({
      viewerParticipantId,
    });
    res.status(200).json({
      schemaVersion: 1,
      csrfToken: guest.csrfToken,
      leaderboard: {
        ...leaderboard,
        entries: await decoratePointsEntries(leaderboard.entries),
        viewer:
          leaderboard.viewer === null
            ? null
            : (await decoratePointsEntries([leaderboard.viewer]))[0],
      },
    });
  } catch (error) {
    sendReplayPremiereFailure(res, error);
  }
});
// -----------------------------------------------------------------------
// Server-to-server projection for the platform's per-account betting
// profile (see `BettingProfileServiceAuth.ts` and `BettingProfileClient.ts`'s
// doc comments for the full contract). NOT a browser-facing route: no
// guest bootstrap, no cookies, nothing here is scoped to a caller's
// session. Keyed by the platform's own opaque `accountId` — a direct,
// O(1) lookup via `BettingPlatformAccountLinkStore.getByPlatformAccountId`,
// never a display-name scan: display names are not unique
// (`PlatformAccountStore.setDisplayName` never enforces it), so matching
// on one — as this route used to — can silently surface one linked
// account's stats under a DIFFERENT account's chosen name. Absent
// entirely unless BOTH wagering is on (there is a ledger to read) AND
// the shared token is configured, matching "unset env means the route
// doesn't exist" elsewhere in this file (GitHub sign-in, above).
// -----------------------------------------------------------------------
const bettingProfileServiceToken = await resolveBettingProfileServiceToken();
if (pointsRoutesEnabled && bettingProfileServiceToken !== null) {
  app.get(
    "/api/internal/accounts/:accountId/betting-profile",
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      const presented = bearerToken(req);
      if (
        presented === undefined ||
        !sameSecretValue(presented, bettingProfileServiceToken)
      ) {
        res
          .status(401)
          .json({ error: { code: "BETTING_PROFILE_UNAUTHORIZED" } });
        return;
      }
      try {
        const link =
          await bettingPlatformAccountLinkStore.getByPlatformAccountId(
            req.params.accountId,
          );
        if (link === null) {
          res.status(200).json({ schemaVersion: 1, profile: null });
          return;
        }
        const board = await replayPremierePointsLedger.readLeaderboard({
          limit: 1,
          viewerParticipantId: link.participantId,
        });
        const viewer = board.viewer;
        res.status(200).json({
          schemaVersion: 1,
          profile:
            viewer !== null &&
            viewer.premieresTraded > 0 &&
            viewer.rank !== null
              ? {
                  lifetimePoints: viewer.lifetimePoints,
                  premieresTraded: viewer.premieresTraded,
                  premieresWon: viewer.premieresWon,
                  rank: viewer.rank,
                  totalRankedParticipants: board.totalRankedParticipants,
                }
              : null,
        });
      } catch (error) {
        sendReplayPremiereFailure(res, error);
      }
    },
  );
}
// The client half. Used by the platform's own
// `/api/accounts/:accountId/betting-profile` (mounted only when
// platformEnabled, further below) ONLY when this process itself has no
// ledger to read (wagering off) and the shared token is configured;
// otherwise `null` and the betting section simply stays absent.
const bettingProfileClient =
  !pointsRoutesEnabled && bettingProfileServiceToken !== null
    ? createBettingProfileClient(bettingOrigin, bettingProfileServiceToken)
    : null;
// -----------------------------------------------------------------------
// Account page: the one place a participant sees everything the system
// knows about THEM, both as a bettor and — if they've made one — as a
// self-asserted league agent owner. Same guest identity and same
// wagering gate as the points routes above.
// -----------------------------------------------------------------------

/**
 * The viewer's own live position in the "current" premiere — same
 * definition `/api/premieres/auth/github/*` uses below (the most
 * recently registered id; at most one premiere has an open market at a
 * time in this exhibition loop). `null` when there is no current
 * premiere, its runtime is gone from the live registry (already
 * reclaimed), or the viewer holds no open position in it — a bankroll
 * entry with zero positions is not a "live position" worth surfacing.
 */
async function readCurrentPremierePositionSummary(
  participantId: string,
): Promise<{
  premiereId: string;
  status: "open" | "settled";
  balance: number | null;
  positionCount: number;
  unrealizedPnl: number;
} | null> {
  const currentPremiereId = replayPremiereHttpRegistry.premiereIds().at(-1);
  if (currentPremiereId === undefined) return null;
  const target = replayPremiereHttpRegistry.get(currentPremiereId);
  if (target === null) return null;
  try {
    const market = target.interactions.readMarketState(participantId);
    const positions = market?.positions ?? [];
    if (positions.length === 0) return null;
    return {
      premiereId: currentPremiereId,
      status: market?.status ?? "open",
      balance: market?.balance ?? null,
      positionCount: positions.length,
      unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    };
  } catch {
    return null;
  }
}

app.get("/api/premieres/account", async (req, res) => {
  if (!pointsRoutesEnabled) {
    res.status(404).json({ error: { code: "PREMIERE_UNAVAILABLE" } });
    return;
  }
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const guest = replayPremiereGuestSecurity.bootstrapRead(
      requestSecurityHeaders(req),
    );
    if (guest.setCookie !== null) {
      res.setHeader("Set-Cookie", guest.setCookie);
    }
    const canonicalParticipantId =
      await bettingPlatformAccountLinkStore.resolveCanonicalParticipantId(
        guest.participant.participantId,
      );
    const [pointsEntry, board, platformLink, currentPremiere] =
      await Promise.all([
        replayPremierePointsLedger.readParticipant(canonicalParticipantId),
        replayPremierePointsLedger.readLeaderboard({
          viewerParticipantId: canonicalParticipantId,
        }),
        bettingPlatformAccountLinkStore.getStatus(canonicalParticipantId),
        readCurrentPremierePositionSummary(canonicalParticipantId),
      ]);
    const matches = Object.entries(pointsEntry?.premiereResults ?? {})
      .map(([premiereId, net]) => ({
        premiereId,
        net,
        revealedAt:
          replayPremiereArchiveStore.lookup(premiereId)?.revealedAt ?? null,
      }))
      .sort((a, b) => {
        const aTime =
          a.revealedAt === null ? -Infinity : Date.parse(a.revealedAt);
        const bTime =
          b.revealedAt === null ? -Infinity : Date.parse(b.revealedAt);
        if (bTime !== aTime) return bTime - aTime;
        return a.premiereId < b.premiereId
          ? -1
          : a.premiereId > b.premiereId
            ? 1
            : 0;
      });
    res.status(200).json({
      schemaVersion: 1,
      csrfToken: guest.csrfToken,
      identity: {
        participantId: canonicalParticipantId,
        // Sourced from the platform via the handoff, cached locally —
        // never written by betting. See `BettingPlatformAccountLinkStore`.
        displayName: platformLink.displayName,
        platformLinked: platformLink.linked,
        // Private, self-asserted, and stale-by-design (refreshed only on
        // the next sign-in) — see `BettingPlatformAccountLinkStore`'s
        // class doc. Never joined into the leaderboard or any public
        // route: only this participant's OWN authenticated read sees it.
        claims: platformLink.claims,
      },
      betting: {
        lifetimePoints: pointsEntry?.lifetimePoints ?? 0,
        premieresTraded: pointsEntry?.premieresTraded ?? 0,
        premieresWon: pointsEntry?.premieresWon ?? 0,
        rank: board.viewer?.rank ?? null,
        totalRankedParticipants: board.totalRankedParticipants,
        matches,
        currentPremiere,
      },
    });
  } catch (error) {
    sendReplayPremiereFailure(res, error);
  }
});

// Narrow, public "who won" read for a premiere whose market has already
// settled — see `ReplayPremiereSettlementLedger`'s class doc for the
// durability/scope reasoning and `PremiereEndedPage.ts` for the one
// caller. Public data, deliberately no guest bootstrap/cookie: the winner
// was always public the instant the market settled, and this route never
// exposes anything narrower than that (no episode payloads, no turn
// data, no per-viewer position). 404 for an id with no recorded
// settlement — a pre-feature premiere, an unsettled/void-without-refund
// premiere state that never reaches this ledger, or simply a bad id; the
// three are indistinguishable on purpose (nothing here should hint at
// whether an id is real).
app.get("/api/premieres/:id/settlement", async (req, res) => {
  if (!pointsRoutesEnabled) {
    res.status(404).json({ error: { code: "PREMIERE_UNAVAILABLE" } });
    return;
  }
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const premiereId = req.params.id;
    const record = PREMIERE_ID_PATTERN.test(premiereId)
      ? await replayPremiereSettlementLedger.readSettlement(premiereId)
      : null;
    if (record === null) {
      res.status(404).json({ error: { code: "SETTLEMENT_NOT_FOUND" } });
      return;
    }
    res.status(200).json({ schemaVersion: 1, settlement: record });
  } catch (error) {
    sendReplayPremiereFailure(res, error);
  }
});

// Narrow, per-record FeaturedMatch detail + participant identity routes
// (product overhaul spec Stage 3 item 6 / hero states A/B). Deliberately
// separate from the bulk `read-model.json` mirror artifact and from the
// `pointsRoutesEnabled` wagering gate above — this is league/editorial
// data (a scheduled or published match and who is in it), always
// available on a league-origin process regardless of the wagering flag,
// exactly like `/league`/`read-model.json` already are. See
// `FeaturedMatchParticipants.ts`'s own doc for why participant identity
// must never be folded into the bulk read model: only a route keyed to
// ONE match id (this route) or ONE live premiere id (the route below) is
// safe, since either requires the caller to already know which specific
// record they're asking about.
async function loadFeaturedMatchDetail(
  match: FeaturedMatch | undefined,
) {
  if (match === undefined) return null;
  const identity = await loadIdentityRegistrySnapshot();
  // Season Zero activation prompt Phase 5: resolves this match's
  // `EventPackage` (if any) so `publicFeaturedMatch`'s
  // `isPubliclyPromotable`/`subtitle`/`reasonToWatch`/`directorCutEstimateSeconds`/
  // canonical-URL fields report real values through this narrow route —
  // without this lookup every record would fall back to `publicFeaturedMatch`'s
  // own safe "no package passed" default (`isPubliclyPromotable: false`),
  // which would make the Phase 5 hero/watch surfaces unable to ever find a
  // real promotable event through this channel.
  const eventPackageStore = await readEventPackageStore(
    resolveEventPackageStateRoot(),
  );
  const eventPackage = findEventPackage(eventPackageStore, match.matchId);
  // Full-replay-access bugfix (2026-08-05): resolves the SAME live mirror
  // episode row `publicFeaturedMatches` (the bulk read model) already
  // resolves `completedAt`/`watchHref`/`fullRenderHref` from — this narrow
  // per-record route previously never loaded the mirror at all, so every
  // record served through it silently fell back to `publicFeaturedMatch`'s
  // "not looked up" defaults (`completedAt: null`, no replay link),
  // leaving `/match/:matchId` (a FeaturedMatch's own canonical page, and
  // the ONLY page a visitor reaches for a revealed/archived Featured
  // Event via the homepage/`/watch` Season schedule) unable to ever show
  // a way to watch the match it was reporting a result for. `null`
  // `episodeRequestId` skips the read entirely (no episode to resolve).
  const episodeRequestId = match.episodeRequestId;
  const mirrorData =
    episodeRequestId === null
      ? null
      : await readLeagueMirrorData(leagueDataJsonPath);
  const episodeReplayInfo =
    mirrorData === null || episodeRequestId === null
      ? null
      : findLeagueEpisodeReplayInfo(mirrorData, episodeRequestId);
  // Full-replay-retention fix (2026-08-06): the live mirror lookup above
  // permanently misses once `episodeRequestId` has rotated out of the
  // mirror's own narrow `episodes[]` window (see
  // `CoworldLeagueArtifactRetention.ts`'s `resolveArchivedEpisodeReplayHrefs`
  // own doc) — only consulted on that miss, never overrides a real live
  // lookup, and never throws.
  const archivedReplayHrefs =
    episodeReplayInfo === null && episodeRequestId !== null
      ? await resolveArchivedEpisodeReplayHrefs(
          summaryArchiveDir,
          episodeRequestId,
        )
      : null;
  return {
    match: publicFeaturedMatch(
      match,
      eventPackage,
      episodeReplayInfo?.completedAt ?? null,
      episodeReplayInfo !== null
        ? {
            watchHref: episodeReplayInfo.watchHref,
            fullRenderHref: episodeReplayInfo.fullRenderHref,
          }
        : archivedReplayHrefs,
    ),
    // Lets the client detect "is this record the CURRENTLY LIVE premiere"
    // via a plain string comparison against the already-fetched read
    // model's `premieres.live.premiereId`, without doing any hashing
    // itself (derivePremiereId is a private server module, and there is
    // no reason to reimplement/expose sha256 derivation client-side for
    // one comparison). Null when the record predates episode-id tracking
    // (FeaturedMatch.ts's own doc) or is archive-lane.
    derivedPremiereId:
      match.episodeRequestId === null
        ? null
        : derivePremiereId(match.episodeRequestId),
    participants: resolveFeaturedMatchParticipantCards(match, identity),
  };
}

app.get("/api/featured-matches/:matchId", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const stateRoot = resolveFeaturedMatchStateRoot();
    const store = await reconcileFeaturedMatchStore(stateRoot, {
      artifactsRoot: artifactsRootDir,
    });
    const match = store.matches.find(
      (candidate) =>
        candidate.matchId === req.params.matchId &&
        candidate.state !== "candidate",
    );
    const detail = await loadFeaturedMatchDetail(match);
    if (detail === null) {
      res.status(404).json({ error: { code: "FEATURED_MATCH_NOT_FOUND" } });
      return;
    }
    res.status(200).json({ schemaVersion: 1, ...detail });
  } catch (error) {
    console.error("GET /api/featured-matches/:matchId failed", error);
    res.status(500).json({ error: { code: "FEATURED_MATCH_LOOKUP_FAILED" } });
  }
});

// Looks up the FeaturedMatch record (if any) whose derived premiere id
// matches `:premiereId` — the lobby hero's lookup direction (it knows the
// LIVE/SCHEDULED premiere id from the league mirror card, not a matchId).
// A live premiere admitted outside the editorial scheduling flow (plain
// FIFO or an exhibition fallback — still the common case; see
// cycle-premiere.sh) has no matching record, and this returns
// `{match: null, participants: []}` with 200, not a 404 - "no featured
// match behind this premiere" is the normal, expected case, not an error.
app.get("/api/premieres/:premiereId/featured-match", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const stateRoot = resolveFeaturedMatchStateRoot();
    const store = await reconcileFeaturedMatchStore(stateRoot, {
      artifactsRoot: artifactsRootDir,
    });
    const match = store.matches.find(
      (candidate) =>
        candidate.lane === "premiere" &&
        candidate.state !== "candidate" &&
        candidate.episodeRequestId !== null &&
        derivePremiereId(candidate.episodeRequestId) === req.params.premiereId,
    );
    const detail = await loadFeaturedMatchDetail(match);
    res.status(200).json({
      schemaVersion: 1,
      match: detail?.match ?? null,
      participants: detail?.participants ?? [],
    });
  } catch (error) {
    console.error(
      "GET /api/premieres/:premiereId/featured-match failed",
      error,
    );
    res.status(500).json({ error: { code: "FEATURED_MATCH_LOOKUP_FAILED" } });
  }
});
// Product overhaul: the ORDINARY-league-episode sibling of
// `/api/featured-matches/:matchId` above — same narrow, per-record shape
// (one id in, one match's page model out), but resolves against the
// hosted Coworld mirror's own `CoworldLeagueEpisodeRow[]` (`data.json`)
// rather than the `feat_...`-namespaced `FeaturedMatch` store. The two id
// spaces never collide (`feat_[a-f0-9]{20}` vs `ereq_[A-Za-z0-9_-]+` — see
// `FeaturedMatch.ts`/`CoworldLeagueMirrorCore.ts`'s own id validators), so
// `MatchDetailPage.ts` dispatches to this route purely from the id's
// prefix rather than probing both. See `LeagueEpisodeMatchPage.ts`'s own
// doc for why every field here is already public (or, for `recap`, drawn
// from the one recap artifact on the public run-artifact allowlist).
app.get("/api/matches/:episodeId", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const episodeId = req.params.episodeId;
    if (typeof episodeId !== "string") {
      res.status(404).json({ error: { code: "LEAGUE_EPISODE_NOT_FOUND" } });
      return;
    }
    const episodes = await readCoworldLeagueEpisodesFromDataJson(
      leagueDataJsonPath,
    );
    const row =
      episodes === null
        ? null
        : findLeagueEpisodeByRequestId(episodes, episodeId);
    if (row === null) {
      res.status(404).json({ error: { code: "LEAGUE_EPISODE_NOT_FOUND" } });
      return;
    }
    const identity = await loadIdentityRegistrySnapshot();
    const runDir = findLeagueEpisodeRunDir(row, runsRootDir);
    const [recap, decisiveMoments] = await Promise.all([
      readLeagueEpisodeRecap(runDir),
      readLeagueEpisodeDecisiveMoments(runDir),
    ]);
    res.status(200).json({
      schemaVersion: 1,
      match: buildLeagueEpisodeMatchPageModel(row, recap, decisiveMoments),
      participants: buildLeagueEpisodeParticipantCards(row, identity),
    });
  } catch (error) {
    console.error("GET /api/matches/:episodeId failed", error);
    res.status(500).json({ error: { code: "LEAGUE_EPISODE_LOOKUP_FAILED" } });
  }
});
// The account page itself — a plain app-shell document, not premiere-
// scoped, so it needs none of `ReplayPremierePublicPage`'s per-premiere
// metadata/CSP machinery. Always reachable (like `/premiere/:id`); the
// client-side component degrades to "betting isn't live here" if the API
// above 404s for a deployment with wagering off.
app.get("/account", async (_req, res) => {
  if (!platformEnabled) {
    if (configuredPlatformOrigin === undefined) {
      res
        .status(503)
        .send(
          "Proxy War account management is not available on this deployment.",
        );
      return;
    }
    res.redirect(302, `${configuredPlatformOrigin}/account`);
    return;
  }
  try {
    const appShell = await getAppShellContent(
      path.resolve(staticRootDir, "index.html"),
    );
    const scriptNonce = randomBytes(24).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      pageContentSecurityPolicyWithNonce(
        leagueContentSecurityPolicy(),
        scriptNonce,
      ),
    );
    setHtmlNoCacheHeaders(res);
    res.send(nonceInlineScripts(appShell, scriptNonce));
  } catch (error) {
    console.error(
      `Failed to serve the account page: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res
      .status(503)
      .send("Proxy War account page is not built for this server.");
  }
});
// -----------------------------------------------------------------------
// League player profile: the destination the PUBLIC league standings
// link to — one place that shows a league competitor's rating/rank now
// plus recent results. Always mounted, ungated by wagering (league data
// is public regardless).
//
// PUBLIC PAGE — keyed ONLY by the league's own player-name namespace,
// which is genuinely unique within the league. This route does NOT, and
// must never, join a league player to a platform account or a betting
// profile by matching display-name TEXT: a league player and an account
// are only the same person by a claim nobody here can verify, and
// display names are not even unique among linked accounts (see
// `BettingPlatformAccountLinkStore.getByPlatformAccountId`'s doc — this
// route used to match on display name and that was unsound). A bettor's
// stats live at their own stable, account-id-keyed profile instead — see
// `GET /api/accounts/:accountId/betting-profile`, mounted on the
// platform below, and `TraderProfilePage.ts` on the client.
// -----------------------------------------------------------------------
const leagueDataJsonPath = path.join(runsRootDir, "league", "data.json");
const agentStatsJsonPath = path.join(runsRootDir, "league", "agent-stats.json");
const standingsHistoryJsonPath = path.join(
  runsRootDir,
  "league",
  "standings-history.json",
);

app.get("/api/players/:name", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const name = req.params.name;
    if (name.length === 0 || name.length > 200) {
      res.status(400).json({ error: { code: "PLAYER_PROFILE_INVALID_NAME" } });
      return;
    }
    const [mirrorData, statsArtifact, standingsHistory] = await Promise.all([
      readLeagueMirrorData(leagueDataJsonPath),
      readAgentStatsArtifact(agentStatsJsonPath),
      readStandingsHistoryStore(standingsHistoryJsonPath),
    ]);
    const league =
      mirrorData === null
        ? null
        : buildLeaguePlayerSection(
            mirrorData,
            name,
            statsArtifact,
            standingsHistory === "corrupt" ? undefined : standingsHistory,
          );
    if (league === null) {
      res.status(404).json({ error: { code: "PLAYER_PROFILE_NOT_FOUND" } });
      return;
    }
    res.status(200).json({ schemaVersion: 1, name, league });
  } catch (error) {
    sendReplayPremiereFailure(res, error);
  }
});
// The player profile page itself — a plain app-shell document, same
// pattern as `/account` above: always reachable, no premiere/session
// machinery behind it, the client-side component does all the fetching
// (`GET /api/players/:name`) and rendering.
app.get("/player/:name", async (_req, res) => {
  try {
    const appShell = await getAppShellContent(
      path.resolve(staticRootDir, "index.html"),
    );
    const scriptNonce = randomBytes(24).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      pageContentSecurityPolicyWithNonce(
        leagueContentSecurityPolicy(),
        scriptNonce,
      ),
    );
    setHtmlNoCacheHeaders(res);
    res.send(nonceInlineScripts(appShell, scriptNonce));
  } catch (error) {
    console.error(
      `Failed to serve the player profile page: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res
      .status(503)
      .send("Proxy War player profile page is not built for this server.");
  }
});
// The trader profile page — a plain app-shell document, same pattern as
// `/player/:name` just above, but keyed by the platform's opaque
// accountId (`GET /api/accounts/:accountId/betting-profile`, mounted
// only when platformEnabled, further below). Always reachable so a
// stale/cross-origin link never 404s at the HTTP layer; the client-side
// component itself renders "not found" for an unknown accountId.
app.get("/trader/:accountId", async (_req, res) => {
  try {
    const appShell = await getAppShellContent(
      path.resolve(staticRootDir, "index.html"),
    );
    const scriptNonce = randomBytes(24).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      pageContentSecurityPolicyWithNonce(
        leagueContentSecurityPolicy(),
        scriptNonce,
      ),
    );
    setHtmlNoCacheHeaders(res);
    res.send(nonceInlineScripts(appShell, scriptNonce));
  } catch (error) {
    console.error(
      `Failed to serve the trader profile page: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res
      .status(503)
      .send("Proxy War trader profile page is not built for this server.");
  }
});
// -----------------------------------------------------------------------
// Stage 2 public pages (product overhaul §4 Target IA): event lobby, watch,
// agents/builders directories and profiles, about — plus Stage 3 item 6's
// `/match/:matchId` canonical FeaturedMatch page. Every one is a plain
// app-shell document — same pattern as `/player/:name`/`/trader/:accountId`
// just above (always reachable, no premiere/session machinery behind it,
// the client-side component does all the fetching, via
// `GET /ai-league-runs/league/read-model.json` plus, for `/match/:matchId`,
// `GET /api/featured-matches/:matchId`, and rendering). Factored into one
// helper here (unlike the three call sites above, which predate this and
// are left as they are) because this adds eight more identical call
// sites — see `getAppShellContent`'s own doc for why this can't be
// hoisted further without breaking the per-request nonce.
// -----------------------------------------------------------------------
// Serves `public.html`'s built output — the Stage 2 public app's own
// lightweight Vite entry (`PublicApp.ts`), deliberately separate from the
// game/replay/premiere `index.html` + `Main.ts` entry every other route
// serves. Every caller below is one of the 9 public-app routes (Stage 7
// adds `/build`); game,
// replay, premiere, `/player/:name`, `/account`, and `/trader/:accountId`
// never call this — they keep using `index.html` unchanged (see
// `RenderHtml.ts`'s `getAppShellContent`, which this reuses unmodified for
// either shell — it's generic over `htmlPath`).
async function sendPublicAppShellPage(
  res: Response,
  failureLabel: string,
  status = 200,
): Promise<void> {
  try {
    const appShell = await getAppShellContent(
      path.resolve(staticRootDir, "public.html"),
    );
    const scriptNonce = randomBytes(24).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      pageContentSecurityPolicyWithNonce(
        leagueContentSecurityPolicy(),
        scriptNonce,
      ),
    );
    setHtmlNoCacheHeaders(res);
    res.status(status).send(nonceInlineScripts(appShell, scriptNonce));
  } catch (error) {
    console.error(
      `Failed to serve ${failureLabel}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res.status(503).send(`Proxy War ${failureLabel} is not built for this server.`);
  }
}
/**
 * P0 fix (found live 2026-08-02): `/ai-league-replay/<bad-id>` rendered a
 * raw, unstyled plain-text response — no branding, no nav — while
 * `/match`/`/agent`/`/builder` bad-ids stay inside the app shell (a
 * themed page, client-rendered not-found state). The replay route can't
 * follow that exact pattern: `assessPremiereLeakAudit`'s `statusHidden`
 * check (`ReplayPremiereEligibility.ts`) requires EXACTLY 403/404 for
 * this precise path when the run id isn't publicly allowlisted — proof a
 * private artifact isn't exposed — so a 200 app-shell response (or a
 * redirect) is not an option here without breaking that safety check
 * every premiere admission depends on. This keeps the required status
 * code and replaces only the body: a small, self-contained branded page
 * (matching the site's dark theme) with working nav links, instead of a
 * bare string.
 */
function sendThemedNotFoundPage(
  res: Response,
  status: number,
  message: string,
  overrides: { title?: string; ctaLabel?: string; ctaHref?: string } = {},
): void {
  const title = overrides.title ?? "Not found";
  const ctaLabel = overrides.ctaLabel ?? "Go to the league";
  const ctaHref = overrides.ctaHref ?? "/league";
  res.status(status).type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Proxy War</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: #07090d;
    color: #e7ebf2;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif;
  }
  nav {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 16px 24px;
    border-bottom: 1px solid #232a3a;
  }
  nav a, .brand {
    color: #8b93a6;
    text-decoration: none;
    font-weight: 700;
    font-size: 13px;
  }
  .brand { color: #e7ebf2; font-size: 15px; margin-right: auto; }
  nav a:hover { color: #e7ebf2; }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 48px 20px;
  }
  h1 { font-size: 28px; margin: 0 0 12px; }
  p { color: #9fb0c3; max-width: 32em; margin: 0 0 24px; }
  a.cta {
    color: #04121e;
    background: #56c7f5;
    text-decoration: none;
    font-weight: 800;
    padding: 10px 20px;
    border-radius: 8px;
  }
</style>
</head>
<body>
  <nav>
    <span class="brand">Proxy War</span>
    <a href="/league">League</a>
    <a href="/watch">Watch</a>
    <a href="/agents">Agents</a>
    <a href="/builders">Builders</a>
    <a href="/build">Build</a>
  </nav>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a class="cta" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaLabel)}</a>
  </main>
</body>
</html>`);
}
// Resolves the spoiler-safe `{title, description}` pair `/match/:matchId`'s
// OG/social card and `<title>` use, from the SAME two sources
// `MatchDetailPage.ts` itself resolves against, in the same order: the
// `feat_...` `FeaturedMatch` store (its own `title`/`description` fields —
// already spoiler-safe for premiere-lane records by construction, and
// archive-lane records are never embargoed in the first place, see
// `isFeaturedMatchRevealed`'s doc), then the `ereq_...` league-episode
// mirror (`leagueEpisodeSpoilerSafeTitle`/`Description` — NEVER the
// winner, per spec). `null` for an unknown/unpublished id; the caller
// then falls back to the site-wide default metadata already baked into
// `public.html` — the client's own "not found" state is what actually
// explains that to a visitor, not the social card.
async function resolveMatchDetailPageMetadata(
  matchId: string,
): Promise<
  | { title: string; description: string; card: MatchShareCardInput }
  | null
> {
  if (matchId.startsWith("feat_")) {
    const stateRoot = resolveFeaturedMatchStateRoot();
    const store = await reconcileFeaturedMatchStore(stateRoot, {
      artifactsRoot: artifactsRootDir,
    });
    const match = store.matches.find(
      (candidate) =>
        candidate.matchId === matchId && candidate.state !== "candidate",
    );
    if (match === undefined) return null;
    const detail = publicFeaturedMatch(match);
    // Spoiler safety is structural here: `result` is only ever non-null on
    // the raw record once `state` is `"revealed"`/`"archived"` (see
    // `FeaturedMatch.ts`'s own embargo contract) — this never independently
    // re-decides revealed-ness, it only ever forwards what's ALREADY safe
    // to read off `match.result`.
    const nameByAgentId = new Map(
      match.participants.map((participant) => [
        participant.agentId,
        participant.playerName,
      ]),
    );
    const card: MatchShareCardInput = {
      matchId,
      title: detail.title,
      mapLabel: match.map,
      participants: match.participants.map((p) => p.playerName),
      result:
        match.result === null
          ? null
          : {
              winnerName:
                match.result.winnerAgentId === null
                  ? null
                  : (nameByAgentId.get(match.result.winnerAgentId) ?? null),
              placements: match.result.placements
                .map((entry) => ({
                  name: entry.agentId === null ? null : nameByAgentId.get(entry.agentId),
                  placement: entry.placement,
                }))
                .filter(
                  (entry): entry is { name: string; placement: number } =>
                    entry.name !== undefined && entry.name !== null,
                ),
            },
    };
    return {
      title: `${detail.title} | Proxy War`,
      description: detail.description,
      card,
    };
  }
  const episodes = await readCoworldLeagueEpisodesFromDataJson(
    leagueDataJsonPath,
  );
  const row =
    episodes === null ? null : findLeagueEpisodeByRequestId(episodes, matchId);
  if (row === null) return null;
  // League episodes are always post-match (see `MatchDetailPage.ts`'s own
  // doc), so the card is always the result variant.
  const card: MatchShareCardInput = {
    matchId,
    title: leagueEpisodeSpoilerSafeTitle(row),
    mapLabel: row.map,
    participants: row.players.map((p) => p.name),
    result: {
      winnerName: row.winnerName,
      placements: [...row.players]
        .sort(
          (left, right) =>
            Number(right.isWinner) - Number(left.isWinner) ||
            right.tilesOwned - left.tilesOwned ||
            left.slot - right.slot,
        )
        .map((player, index) => ({ name: player.name, placement: index + 1 })),
    },
  };
  return {
    title: leagueEpisodeSpoilerSafeTitle(row),
    description: leagueEpisodeSpoilerSafeDescription(row),
    card,
  };
}

/**
 * Best-effort agent/builder slug existence check for the /agent/:slug and
 * /builder/:slug status-code-parity fix (P2, 2026-08-02): reads the SAME
 * `read-model.json` `AgentProfilePage.ts`/`BuilderProfilePage.ts` already
 * fetch client-side, replicating each page's own `load()` match rule
 * exactly — a registered agent's `slug`, OR (agents only) any
 * UNREGISTERED agent's `provisionalSlug` (see `AgentProfilePage.ts`'s own
 * doc for why a live provisional identity must resolve too, same as
 * `loadAnalyticsMatchLabels` above reads this file). Never throws and a
 * read/parse failure returns `null` rather than empty sets — the route
 * handlers below treat that as "can't tell", degrading to 200 (serve
 * normally) rather than falsely 404ing a page that might be real.
 */
async function loadReadModelSlugSets(): Promise<{
  agentSlugs: Set<string>;
  builderSlugs: Set<string>;
} | null> {
  try {
    const raw = await fs.readFile(
      path.join(runsRootDir, "league", "read-model.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { agents?: unknown; builders?: unknown };
    const agentSlugs = new Set<string>();
    for (const entry of Array.isArray(parsed.agents) ? parsed.agents : []) {
      const agent = entry as {
        slug?: unknown;
        registered?: unknown;
        provisionalSlug?: unknown;
      };
      if (typeof agent.slug === "string") agentSlugs.add(agent.slug);
      if (
        agent.registered === false &&
        typeof agent.provisionalSlug === "string"
      ) {
        agentSlugs.add(agent.provisionalSlug);
      }
    }
    const builderSlugs = new Set<string>();
    for (const entry of Array.isArray(parsed.builders) ? parsed.builders : []) {
      const builder = entry as { slug?: unknown };
      if (typeof builder.slug === "string") builderSlugs.add(builder.slug);
    }
    return { agentSlugs, builderSlugs };
  } catch {
    return null;
  }
}
// Serves `/match/:matchId` — same `public.html` shell as every other
// `sendPublicAppShellPage` route, but with per-match OG/social metadata
// spliced into `<head>` (title, description, canonical, `og:*`,
// `twitter:*`) so a shared link previews the actual match instead of the
// generic site card. Reuses `stripShellSocialMetadata` from
// `ReplayPremierePublicPage.ts` (the exact same strip this file's own
// premiere page already relies on) rather than a second parallel regex
// implementation. A metadata-resolution failure of any kind (unknown id,
// corrupt store/mirror file) degrades to the generic site-wide card
// exactly like `sendPublicAppShellPage` — never a 5xx for a viewer who
// simply followed a stale or malformed link.
async function sendMatchDetailPageShell(
  req: Request,
  res: Response,
): Promise<void> {
  const matchId = req.params.matchId;
  if (typeof matchId !== "string") {
    res.status(400).send("Invalid match id");
    return;
  }
  try {
    const appShell = await getAppShellContent(
      path.resolve(staticRootDir, "public.html"),
    );
    const metadata = await resolveMatchDetailPageMetadata(matchId).catch(
      () => null,
    );
    const scriptNonce = randomBytes(24).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      pageContentSecurityPolicyWithNonce(
        leagueContentSecurityPolicy(),
        scriptNonce,
      ),
    );
    setHtmlNoCacheHeaders(res);
    // P2 status-code-parity fix (2026-08-02): `metadata === null` means
    // `resolveMatchDetailPageMetadata` couldn't resolve this id to a real,
    // revealed record — the SAME condition `MatchDetailPage.ts`'s client
    // renders its own honest not-found state for. A crawler or health
    // check must see a genuine 404, not a 200 for a page whose only
    // content is "not found" (see item 2 of the 2026-08-02 P2 batch).
    if (metadata === null) {
      res.status(404).send(nonceInlineScripts(appShell, scriptNonce));
      return;
    }
    const canonicalUrl = new URL(
      `/match/${encodeURIComponent(matchId)}`,
      replayPremierePublicOrigin,
    ).href;
    const cardUrl = new URL(
      `/match/${encodeURIComponent(matchId)}/card-v1.svg`,
      replayPremierePublicOrigin,
    ).href;
    const socialTags = [
      `<title>${escapeHtml(metadata.title)}</title>`,
      `<meta name="description" content="${escapeHtml(metadata.description)}">`,
      `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
      `<meta property="og:site_name" content="Proxy War">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
      `<meta property="og:title" content="${escapeHtml(metadata.title)}">`,
      `<meta property="og:description" content="${escapeHtml(metadata.description)}">`,
      `<meta property="og:image" content="${escapeHtml(cardUrl)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${escapeHtml(metadata.title)}">`,
      `<meta name="twitter:description" content="${escapeHtml(metadata.description)}">`,
      `<meta name="twitter:image" content="${escapeHtml(cardUrl)}">`,
    ].join("\n");
    const withMetadata = stripShellSocialMetadata(appShell).replace(
      /<head(?:\s[^>]*)?>/i,
      (headTag) => `${headTag}\n${socialTags}`,
    );
    res.send(nonceInlineScripts(withMetadata, scriptNonce));
  } catch (error) {
    console.error(
      `Failed to serve the match detail page: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res
      .status(503)
      .send("Proxy War the match detail page is not built for this server.");
  }
}
// The event lobby (spec Stage 2 item 4) — replaces the bare
// `leagueWrapperOnly` gate's `res.redirect("/league")` fallback for "/"
// that the live beta.proxywar.xyz process has served until now. Only takes
// over in that exact mode: `leagueWrapperOnly && !platformEnabled` is
// precisely the condition under which the later gate middleware (below)
// would otherwise have redirected "/" to `/league`. Every other mode falls
// through via `next()` to the existing conditional handler further down
// this file (`platformEnabled` -> platform root page;
// `betaAccess.enabled` -> `/public`; else -> the internal demo hub) —
// unchanged, untouched, never intercepted.
//
// The `pointsRoutesEnabled` check MUST run FIRST, ahead of the
// `leagueWrapperOnly && !platformEnabled` branch immediately below (P0
// fix, live 2026-08-02): production bet-origin sets BOTH flags true
// (cycle-premiere.sh's `start_origin()`: `PROXYWAR_WAGERING_ENABLED=1` AND
// `PROXYWAR_LEAGUE_WRAPPER_ONLY=true`, with `PROXYWAR_PLATFORM_ENABLED`
// never set), so the demo-hub branch below would otherwise ALWAYS win —
// a cache-busted GET of bet.proxywar.xyz/ served the legacy internal demo
// shell ("Proxy War (ALPHA)") instead of the live market, even though
// `/bet` on the exact same origin already correctly resolved to it. The
// betting origin's homepage must BE the market: redirect to `/bet` (the
// existing, unchanged redirect below) rather than duplicating its
// premiere-resolution/503 logic here.
app.get("/", async (_req, res, next) => {
  if (pointsRoutesEnabled) {
    res.redirect(302, "/bet");
    return;
  }
  if (leagueWrapperOnly && !platformEnabled) {
    await sendPublicAppShellPage(res, "the event lobby");
    return;
  }
  next();
});
app.get("/watch", async (_req, res) => {
  await sendPublicAppShellPage(res, "the watch page");
});
app.get("/agents", async (_req, res) => {
  await sendPublicAppShellPage(res, "the agents directory");
});
app.get("/agent/:slug", async (req, res) => {
  // P2 status-code-parity fix (2026-08-02): see `loadReadModelSlugSets`'s
  // own doc — `null` means "can't tell", never a false 404.
  const slugs = await loadReadModelSlugSets();
  const status =
    slugs !== null && !slugs.agentSlugs.has(req.params.slug) ? 404 : 200;
  await sendPublicAppShellPage(res, "the agent profile page", status);
});
app.get("/builders", async (_req, res) => {
  await sendPublicAppShellPage(res, "the builders directory");
});
app.get("/builder/:slug", async (req, res) => {
  // P2 status-code-parity fix (2026-08-02): see `loadReadModelSlugSets`'s
  // own doc — `null` means "can't tell", never a false 404.
  const slugs = await loadReadModelSlugSets();
  const status =
    slugs !== null && !slugs.builderSlugs.has(req.params.slug) ? 404 : 200;
  await sendPublicAppShellPage(res, "the builder profile page", status);
});
app.get("/match/:matchId", async (req, res) => {
  await sendMatchDetailPageShell(req, res);
});
// Season Zero Phase 2 share image — see `MatchShareCard.ts`'s own doc for
// why this is SVG (no PNG rasterizer in this repo) rather than a new
// pipeline. Spoiler safety is structural: `resolveMatchDetailPageMetadata`
// only ever hands back a real `result` once the underlying record is
// already safe to reveal (see that function's own doc) — this route
// never independently decides embargo state.
app.get("/match/:matchId/card-v1.svg", async (req, res) => {
  const matchId = req.params.matchId;
  try {
    const metadata =
      typeof matchId === "string"
        ? await resolveMatchDetailPageMetadata(matchId)
        : null;
    if (metadata === null) {
      res.status(404).send("Not found");
      return;
    }
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).send(renderMatchShareCardSvg(metadata.card));
  } catch (error) {
    console.error(
      `Failed to render match share card: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res.status(503).send("Not available");
  }
});
app.get("/about", async (_req, res) => {
  await sendPublicAppShellPage(res, "the about page");
});
app.get("/build", async (_req, res) => {
  await sendPublicAppShellPage(res, "the build flow");
});
// Season Zero activation Phase 3+6: the verified-claim flow and the
// minimal Builder dashboard are both public-app-shell pages (same
// `public.html` shell, client-side routed) — never operator-gated,
// exactly like every other `sendPublicAppShellPage` route above.
app.get("/claim", async (_req, res) => {
  await sendPublicAppShellPage(res, "the builder claim page");
});
app.get("/claim/:agentSlug", async (_req, res) => {
  await sendPublicAppShellPage(res, "the builder claim page");
});
app.get("/builder-dashboard", async (_req, res) => {
  await sendPublicAppShellPage(res, "the builder dashboard");
});
// GitHub sign-in lives ONLY on the platform now — proxywar.xyz is the
// sole account authority (see the platform build's contract). Exactly one
// of the two branches below mounts, based on `PROXYWAR_PLATFORM_ENABLED`:
//
// - Platform mode: the real `/api/auth/github/*` routes (only when OAuth
//   credentials are configured — see `resolveGithubOAuthConfig`; unset
//   means these paths simply don't exist, matching "unset env means the
//   route doesn't exist" rather than "exists but always fails") plus the
//   account/claim/handoff-issuance API.
// - Child (betting) mode: the handoff start/callback routes that redirect
//   to the platform and redeem its opaque code server-to-server — never
//   GitHub directly.
if (platformEnabled) {
  // --- Platform-only state (proxywar.xyz) ---------------------------
  // Every store below lives in its OWN root (`resolvePlatformPrivateStateRoot`,
  // default `storage/platform-private`, override via
  // PROXYWAR_PLATFORM_STATE_ROOT) — distinct from both the premiere state
  // root (wiped every betting cycle) and the points-ledger root above
  // (betting's own durable state). Constructed ONLY here, inside
  // `platformEnabled` — a betting/league process never touches this root
  // at all, satisfying the contract's "one writer per file" rule by
  // construction, not just by convention.
  const platformPrivateStateRoot = resolvePlatformPrivateStateRoot();
  const platformAccountStore = await PlatformAccountStore.open(
    platformPrivateStateRoot,
  );
  const platformPolicyClaimStore = await PlatformPolicyClaimStore.open(
    platformPrivateStateRoot,
  );
  const platformGithubIdentityLinkStore =
    await PlatformGithubIdentityLinkStore.open(
      platformPrivateStateRoot,
      platformAccountStore,
      platformPolicyClaimStore,
    );
  const platformHandoffStore = new PlatformHandoffStore();
  const platformAccountSecurity = new PlatformAccountSecurity({
    hmacKey: await loadOrCreatePlatformHmacKey({
      privateStateRoot: platformPrivateStateRoot,
      servedRoots: [
        process.cwd(),
        staticRootDir,
        artifactsRootDir,
        docsRootDir,
        externalAgentExampleRootDir,
      ],
      configuredHex: firstConfiguredEnv(PLATFORM_HMAC_HEX_ENV),
    }),
    expectedOrigin: replayPremierePublicOrigin,
    production: replayPremierePublicOrigin.startsWith("https://"),
  });
  const platformReturnOrigins = resolvePlatformReturnOrigins();
  if (githubOAuthClient !== null) {
    app.use(
      createPlatformGithubAuthRouter({
        security: platformAccountSecurity,
        identityLinkStore: platformGithubIdentityLinkStore,
        oauthClient: githubOAuthClient,
        publicOrigin: replayPremierePublicOrigin,
        onOperatorError: (operatorCode, error) => {
          console.error(
            `Platform GitHub sign-in ${operatorCode}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      }),
    );
  }
  app.use(
    createPlatformAccountRouter({
      security: platformAccountSecurity,
      accounts: platformAccountStore,
      claims: platformPolicyClaimStore,
      identityLinkStore: platformGithubIdentityLinkStore,
      handoffs: platformHandoffStore,
      returnOrigins: platformReturnOrigins,
      githubSignInAvailable: githubOAuthClient !== null,
      artifactsRootDir,
      onOperatorError: (operatorCode, error) => {
        console.error(
          `Platform account ${operatorCode}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    }),
  );
  // --- Season Zero activation Phase 3+6: Builder/Agent/Version claim
  // workflow + the builder-improvement loop. Each store below is its own
  // FileMutex-backed subdirectory of `platformPrivateStateRoot` (see each
  // store's own doc for why: an operator CLI — `identity:claims`,
  // `identity:edits`, `identity:releases` — mutates these as a SEPARATE OS
  // process while this server keeps accepting requests, the same
  // cross-process concurrency contract `FeaturedMatch.ts` already has).
  // One bounded block, mounted immediately after the account router above.
  const builderClaimStateRoot = resolveBuilderClaimStateRoot();
  const builderEditStateRoot = resolveBuilderEditStateRoot();
  const versionReleaseStateRoot = resolveVersionReleaseStateRoot();
  app.use(
    createPlatformBuilderClaimRouter({
      security: platformAccountSecurity,
      claimStore: { stateRoot: builderClaimStateRoot },
      identityLinkStore: platformGithubIdentityLinkStore,
      onOperatorError: (operatorCode, error) => {
        console.error(
          `Platform builder claim ${operatorCode}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    }),
  );
  app.use(
    createPlatformBuilderEditRouter({
      security: platformAccountSecurity,
      editStore: { stateRoot: builderEditStateRoot },
      claimStore: { stateRoot: builderClaimStateRoot },
      identityLinkStore: platformGithubIdentityLinkStore,
      onOperatorError: (operatorCode, error) => {
        console.error(
          `Platform builder edit ${operatorCode}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    }),
  );
  app.use(
    createPlatformBuilderVersionRouter({
      security: platformAccountSecurity,
      releaseStore: { stateRoot: versionReleaseStateRoot },
      claimStore: { stateRoot: builderClaimStateRoot },
      identityLinkStore: platformGithubIdentityLinkStore,
      artifactsRootDir,
      onOperatorError: (operatorCode, error) => {
        console.error(
          `Platform version release ${operatorCode}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    }),
  );
  app.use(
    createPlatformBuilderDashboardRouter({
      security: platformAccountSecurity,
      claimStore: { stateRoot: builderClaimStateRoot },
      releaseStore: { stateRoot: versionReleaseStateRoot },
      identityLinkStore: platformGithubIdentityLinkStore,
      readModelFilePath: path.join(runsRootDir, "league", "read-model.json"),
      featuredMatchStateRoot: resolveFeaturedMatchStateRoot(),
      onOperatorError: (operatorCode, error) => {
        console.error(
          `Platform builder dashboard ${operatorCode}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    }),
  );
  // Public per-account betting profile — the destination the betting
  // leaderboard links to for a genuinely LINKED row (see
  // `accountProfileUrl`/`PointsLeaderboard.ts` and `TraderProfilePage.ts`
  // on the client). Keyed by THIS origin's own opaque `accountId`,
  // resolved from `platformAccountStore` — never from a display-name
  // match (see `/api/players/:name`'s doc, above). `betting` degrades to
  // `null` — never a 500 — when betting is unreachable, slow, or has no
  // shared secret configured; see `BettingProfileClient`'s doc.
  app.get("/api/accounts/:accountId/betting-profile", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const accountId = req.params.accountId;
      const account = await platformAccountStore
        .getAccount(accountId)
        .catch(() => null);
      if (account === null) {
        res.status(404).json({ error: { code: "PLATFORM_ACCOUNT_NOT_FOUND" } });
        return;
      }
      const betting =
        bettingProfileClient === null
          ? null
          : await bettingProfileClient.fetchProfile(accountId);
      res.status(200).json({
        schemaVersion: 1,
        accountId,
        displayName: account.displayName,
        betting,
      });
    } catch (error) {
      sendReplayPremiereFailure(res, error);
    }
  });
} else if (configuredPlatformOrigin !== undefined) {
  app.use(
    createBettingIdentityHandoffRouter({
      security: replayPremiereGuestSecurity,
      linkStore: bettingPlatformAccountLinkStore,
      handoffClient: createPlatformHandoffClient(configuredPlatformOrigin),
      platformOrigin: configuredPlatformOrigin,
      ownOrigin: replayPremierePublicOrigin,
      resolveCurrentMarketIdentityGuard: () => {
        const currentPremiereId = replayPremiereHttpRegistry
          .premiereIds()
          .at(-1);
        if (currentPremiereId === undefined) return null;
        return (
          replayPremiereHttpRegistry.get(currentPremiereId)?.interactions ??
          null
        );
      },
      onOperatorError: (operatorCode, error) => {
        console.error(
          `Identity handoff ${operatorCode}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    }),
  );
  app.use(
    createBettingIdentityStatusRouter({
      security: replayPremiereGuestSecurity,
      linkStore: bettingPlatformAccountLinkStore,
      handoffAvailable: true,
      onOperatorError: (operatorCode, error) => {
        console.error(
          `Identity status ${operatorCode}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    }),
  );
} else {
  app.use(
    createBettingIdentityStatusRouter({
      security: replayPremiereGuestSecurity,
      linkStore: bettingPlatformAccountLinkStore,
      handoffAvailable: false,
    }),
  );
}

app.use(
  createReplayPremiereRouter({
    registry: replayPremiereHttpRegistry,
    security: replayPremiereGuestSecurity,
    clips: replayPremiereClips ?? undefined,
    resolveClientAddress: createReplayPremiereTrustedProxyAddressResolver({
      // The managed Cloudflare tunnel reaches this process over loopback. Do
      // not trust forwarding headers from LAN or directly exposed peers.
      trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
    }),
    // Closes the durable Sybil hole: a signed cookie merged away by a
    // platform-account link (on this device, another device, or a prior
    // premiere/process lifetime) resolves to its canonical id before it
    // ever reaches `interactions`, at every authenticated boundary — not
    // just the settlement/points routes wired below. Local, cached file
    // lookup (see
    // `BettingPlatformAccountLinkStore.resolveCanonicalParticipantId`) —
    // never a call to the platform — so a platform outage can never
    // block, delay, or fail a trade.
    resolveCanonicalParticipantId: (participantId) =>
      bettingPlatformAccountLinkStore.resolveCanonicalParticipantId(
        participantId,
      ),
    onOperatorError: (error) => {
      console.error(formatReplayPremiereHttpOperatorError(error));
    },
  }),
);
if (replayPremiereClips !== null) {
  // The mp4 file is a document route (like the SVG card), not an /api route.
  app.use(
    createReplayPremiereClipDocumentRouter({
      clips: replayPremiereClips,
      resolveLifecycle: (premiereId) =>
        replayPremiereHttpRegistry.get(premiereId)?.runtime ?? null,
      onOperatorError: (error) => {
        console.error(formatReplayPremiereHttpOperatorError(error));
      },
    }),
  );
}
// Mounted BEFORE the public-page router: a revealed premiere whose live runtime
// has de-registered (post-reveal reclamation, or a fresh restart) is served its
// durable results-summary page here. It defers to the live router for still-
// registered premieres and for unknown ids.
const replayRunClipsForArchive = aiLeagueRunClipsEnabled
  ? aiLeagueRunClips
  : null;
app.use(
  createReplayPremiereArchiveRouter({
    registry: replayPremiereHttpRegistry,
    archiveStore: replayPremiereArchiveStore,
    loadAppShell: () =>
      getAppShellContent(path.resolve(staticRootDir, "index.html")),
    publicOrigin: replayPremierePublicOrigin,
    pageContentSecurityPolicy: leagueContentSecurityPolicy(),
    resolveClipGenerationTarget:
      replayRunClipsForArchive === null
        ? undefined
        : async (replayRunKey) =>
            (await replayRunClipsForArchive.resolveRetainedRunSource(
              replayRunKey,
            )) !== null,
    onOperatorError: (error) => {
      console.error(formatReplayPremiereHttpOperatorError(error));
    },
  }),
);
// Stable entry point. Every admission mints a fresh premiere id, so a link to
// /bet/<id> dies as soon as the demo cycles onto the next match. /bet resolves
// to whatever is registered right now, which keeps a shared URL alive across
// cycles. Redirect rather than render, so the address bar still shows the
// concrete premiere being traded.
app.get("/bet", (request, response) => {
  const ids = replayPremiereHttpRegistry.premiereIds();
  const current = ids.at(-1);
  if (current === undefined) {
    // Between cycles (a settled premiere replacing, or the queue briefly
    // empty) — genuinely temporary, not a broken link, so this is neither
    // `sendThemedNotFoundPage`'s default "Not found" framing nor a raw
    // plain-text 503 (the previous behavior here — no branding, no nav,
    // indistinguishable from a real outage to a visitor who just wants to
    // trade). Same themed shell, honest copy, and a retry-shortly nudge
    // instead of a dead end.
    sendThemedNotFoundPage(
      response,
      503,
      "No premiere is currently running. The next one comes up automatically within a few minutes.",
      { title: "Between markets", ctaLabel: "Go to the league", ctaHref: "/league" },
    );
    return;
  }
  // The GitHub callback lands on /bet?github=… and this is a second hop, so
  // the marker has to survive or the sign-in banner never renders. Carry only
  // the allowlisted values — this path is reached straight from an external
  // provider's redirect, so nothing else is echoed onward.
  const marker = request.query.github;
  const suffix =
    marker === "linked" || marker === "error" || marker === "active_trade"
      ? `?github=${marker}`
      : "";
  response.redirect(302, `/bet/${current}${suffix}`);
});
app.use(
  createReplayPremierePublicPageRouter({
    registry: replayPremiereHttpRegistry,
    loadAppShell: () =>
      getAppShellContent(path.resolve(staticRootDir, "index.html")),
    publicOrigin: replayPremierePublicOrigin,
    pageContentSecurityPolicy: leagueContentSecurityPolicy(),
  }),
);
app.use(
  createAiLeagueClipCanaryWriteRefusal({
    isCanaryActive: () =>
      aiLeagueClipCanaryState.claimable || aiLeagueClipCanaryState.readEnabled,
  }),
);
const leagueWrapperOnly = process.env.PROXYWAR_LEAGUE_WRAPPER_ONLY === "true";
app.use((req, res, next) => {
  if (
    leagueWrapperOnly &&
    req.method === "POST" &&
    matchProxyWarLeagueClipWritePath(req.path) !== null &&
    !leagueClipPublicWriteAllowed(req.path)
  ) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.status(404).json({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } });
    return;
  }
  next();
});
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));
app.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

// League-wrapper-only mode: serve nothing but the public league mirror and
// its replay renders. Every other surface — beta login, hub, /play, tester
// dashboard, admin, relay, job APIs (anything that could start a match on
// the operator's account) — is unreachable. Reversible via env flag.
if (leagueWrapperOnly) {
  app.use((req, res, next) => {
    // `/api/build/*` is genuinely public (Stage 7's whole goal is a
    // visitor becoming a competing builder without friction) and touches
    // neither the operator's Coworld/Softmax account nor any match/relay
    // state — safe in the same sense the premiere/points/account read-
    // write paths below already are. Checked first since it applies to
    // both the GET and POST branches below.
    if (req.path.startsWith("/api/build/")) {
      next();
      return;
    }
    // `/api/analytics/events` (Phase 7) is the same shape of exception:
    // anonymous, PII-free, additive-only, and touches neither the
    // operator's account nor any match/relay state. It must stay reachable
    // in wrapper-only mode since that's the hardened mode the live public
    // surface actually runs in — an ingest endpoint that only works in
    // every OTHER mode would silently collect nothing in production.
    if (req.path.startsWith("/api/analytics/")) {
      next();
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const leagueClipRead = matchProxyWarLeagueClipReadPath(req.path);
      if (
        isProxyWarPublicLeaguePath(req.path) ||
        isProxyWarPublicPremiereReadPath(req.path) ||
        isProxyWarPublicPointsReadPath(req.path) ||
        isProxyWarPublicAccountReadPath(req.path) ||
        isProxyWarPublicRendererAssetPath(req.path) ||
        // The platform's own homepage — only when platformEnabled — see
        // `PlatformRootPage.ts`. Every other process keeps redirecting an
        // unmatched "/" to /league exactly as before.
        (platformEnabled && req.path === "/") ||
        // League-run clip status/mp4 for mirror-published (league-*) runs —
        // exactly the runs whose replay pages are already public.
        leagueClipPublicReadAllowed(req.path)
      ) {
        next();
        return;
      }
      // A syntactically valid Clip read that is outside the active surface
      // (including every non-target read during a one-shot canary) is still a
      // Clip route. Fail it closed here instead of letting the wrapper's
      // generic document fallback turn an unavailable artifact into /league.
      if (leagueClipRead !== null) {
        // A missing bucket can become available later after an authorized
        // render. Never let the edge cache this pre-gate 404 and mask the
        // subsequent immutable Clip document or ready status.
        res.setHeader("Cache-Control", "no-store, max-age=0");
        if (leagueClipRead.kind === "clip_status") {
          res.status(404).json({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } });
        } else {
          res.status(404).end();
        }
        return;
      }
      if (isProxyWarReplayOrRunPath(req.path)) {
        sendThemedNotFoundPage(res, 404, "AI league replay record not found.");
        return;
      }
      // P0 fix (found live 2026-08-02): this used to silently
      // `res.redirect("/league")` for ANY unrecognized path, with no
      // acknowledgment a visitor's URL was actually wrong — a typo'd or
      // stale link looked indistinguishable from a normal league visit.
      // Same themed page the replay route above uses (status 404, real
      // nav) rather than a silent bounce.
      sendThemedNotFoundPage(res, 404, "This page doesn't exist.");
      return;
    }
    if (req.method === "POST") {
      const leagueClipWrite = matchProxyWarLeagueClipWritePath(req.path);
      if (leagueClipWrite !== null) {
        if (leagueClipPublicWriteAllowed(req.path)) {
          next();
          return;
        }
        res.setHeader("Cache-Control", "no-store, max-age=0");
        res.status(404).json({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } });
        return;
      }
      if (
        isProxyWarPublicPremiereWritePath(req.path) ||
        isProxyWarPublicPointsWritePath(req.path) ||
        isProxyWarPublicAccountWritePath(req.path)
      ) {
        next();
        return;
      }
    }
    res.status(404).send("not available in league wrapper mode");
  });
}
// `/build`'s own API surface — registered here (BEFORE the beta invite-code
// gate below, so `/build` stays reachable whether or not the internal hub's
// invite gate is on) and explicitly exempted from the leagueWrapperOnly
// restriction above. `leagueWrapperOnly` is the hardened deployment mode
// that also happens to be the ONLY mode where the built public-app static
// bundle (`/assets/*`, matched by `isProxyWarPublicRendererAssetPath`) gets
// served at all — so a `/build` blocked there would render its page shell
// with a form that silently 404s on submit: exactly the "misleading
// dashboard shell" the overhaul instructions forbid. None of the three
// routes below touch the operator's Coworld/Softmax account, start a
// match, or write to the identity registry (see each handler's own doc).

/**
 * `/build` Step 3's live emblem preview — pure, deterministic, no writes.
 * Lets a visitor see the emblem + colors their entered Agent name would
 * produce before submitting anything (same generator the real registry
 * uses once an operator merges the submission — see
 * `IdentityEmblems.ts`'s doc: same id, same bytes, forever).
 */
app.get("/api/build/emblem-preview", (req, res) => {
  if (!enforceRateLimit("build", rateLimits.build, req, res)) {
    return;
  }
  const rawSlug = typeof req.query.slug === "string" ? req.query.slug : "";
  const parsedSlug = SlugSchema.safeParse(rawSlug);
  if (!parsedSlug.success) {
    res.status(400).json({ ok: false, error: "invalid_slug" });
    return;
  }
  const seed = `agt_${parsedSlug.data}`;
  const palette = deriveEmblemPalette(seed);
  res.json({
    ok: true,
    svg: generateEmblemSvg(seed),
    primaryColor: palette.primary,
    secondaryColor: palette.secondary,
  });
});

/**
 * `/build` Step 3's registration submission — validates the form against
 * the real registry schemas and returns a copy-pasteable profile-file JSON
 * plus a prefilled GitHub issue URL. Never writes to
 * `resources/identity/*.json` itself — see `BuildRegistrationSubmission.ts`'s
 * doc for why instant self-service publication isn't safe.
 */
app.post("/api/build/registration-submission", (req, res) => {
  if (!enforceRateLimit("build", rateLimits.build, req, res)) {
    return;
  }
  const parsed = BuildRegistrationSubmissionInputSchema.safeParse(req.body);
  if (!parsed.success) {
    // 2026-08-01 P1 fix: a bare `invalid_submission` gave a visitor no clue
    // WHICH of the form's ten fields failed (e.g. a space in the optional
    // GitHub-username field) — `firstFieldError` names it so the client can
    // show an inline, per-field message instead of only a generic banner.
    const fieldError = firstFieldError(parsed.error);
    res.status(400).json({
      ok: false,
      error: "invalid_submission",
      ...(fieldError ?? {}),
    });
    return;
  }
  const draft = buildRegistrationDraft(parsed.data);
  res.json({
    ok: true,
    proposedAgent: draft.proposedAgent,
    proposedBuilder: draft.proposedBuilder,
    emblemPreviewSvg: draft.emblemPreviewSvg,
    profileFileJson: draft.profileFileJson,
    githubIssueUrl: buildRegistrationIssueUrl(draft),
  });
});

/**
 * `/build`'s silent step-progression counter — spec Stage 7 item 4
 * ("collect, don't gate"). Fire-and-forget from the client; the response is
 * always 204 regardless of whether the write lands, since nothing may ever
 * depend on this succeeding.
 */
app.post("/api/build/funnel-event", (req, res) => {
  if (!enforceRateLimit("build", rateLimits.build, req, res)) {
    return;
  }
  const step = req.body?.step;
  void buildFunnelCounters.recordStepReached(
    typeof step === "number" ? step : -1,
  );
  res.status(204).end();
});

/**
 * Phase 7 product-analytics ingest — batched, schema-validated, additive-
 * only, no PII (see `AnalyticsEventSchema.ts`'s doc). Same silent-collector
 * shape as `/api/build/funnel-event` immediately above: always 204,
 * regardless of whether the batch validated, was rate-limited, or landed —
 * nothing here may ever surface an error a visitor's UX depends on.
 */
app.post("/api/analytics/events", (req, res) => {
  if (!enforceRateLimit("analytics", rateLimits.analytics, req, res)) {
    return;
  }
  void analyticsIngestService.ingest(req.body);
  res.status(204).end();
});

/**
 * Phase 7 operator report — invite-gated exactly like `/tester-dashboard`
 * (same `hasValidBetaSession` check `AgentDemoHub.ts`'s tester dashboard
 * relies on via the global gate further down this file), but registered
 * here — beside its own ingest route — rather than beside
 * `/tester-dashboard`, so this feature's server wiring stays one bounded
 * block instead of touching that unrelated, frequently-edited section.
 */
app.get("/analytics-report", async (req, res) => {
  if (betaAccess.enabled && !hasValidBetaSession(req)) {
    res.redirect(`/beta?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  const [aggregates, recentEvents, matchLabels] = await Promise.all([
    analyticsAggregateStore.readAll(),
    analyticsRecentRing.readAll(),
    loadAnalyticsMatchLabels(),
  ]);
  const report = buildAnalyticsReport(aggregates);
  res.type("html").send(
    renderAnalyticsReportHtml({
      report: {
        ...report,
        mostWatchedEvents: applyMatchLabels(report.mostWatchedEvents, (matchId) =>
          matchLabels.get(matchId) ?? null,
        ),
      },
      recentEvents,
    }),
  );
});
app.get("/api/analytics-report", async (req, res) => {
  if (betaAccess.enabled && !hasValidBetaSession(req)) {
    res.status(401).json({ error: "Proxy War beta invite required" });
    return;
  }
  const [aggregates, matchLabels] = await Promise.all([
    analyticsAggregateStore.readAll(),
    loadAnalyticsMatchLabels(),
  ]);
  const report = buildAnalyticsReport(aggregates);
  res.json({
    ...report,
    mostWatchedEvents: applyMatchLabels(report.mostWatchedEvents, (matchId) =>
      matchLabels.get(matchId) ?? null,
    ),
  });
});
/**
 * Best-effort matchId -> human label lookup for the "most-watched matches"
 * ranking (`AnalyticsReport.ts`'s `applyMatchLabels`) — reads the SAME
 * league read-model JSON `PlatformBuilderDashboardHttp`'s `readModelFilePath`
 * already points at. `PublicMatch.matchId` is the actual league run id
 * `director_cut_started`'s context carries (checked first); a
 * `PublicFeaturedMatch.matchId` — a distinct `feat_...` editorial
 * namespace — is included too in case a future emission point ever uses
 * that id space. Never throws: a missing/malformed/absent read-model file
 * just means every ranked item falls back to its raw id (`applyMatchLabels`
 * already handles that), not a broken report page.
 */
async function loadAnalyticsMatchLabels(): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  try {
    const raw = await fs.readFile(
      path.join(runsRootDir, "league", "read-model.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      matches?: unknown;
      featuredMatches?: unknown;
    };
    for (const entry of Array.isArray(parsed.matches) ? parsed.matches : []) {
      const match = entry as { matchId?: unknown; map?: unknown; roundNumber?: unknown };
      if (typeof match.matchId === "string" && typeof match.map === "string") {
        labels.set(
          match.matchId,
          typeof match.roundNumber === "number"
            ? `${match.map} (round ${match.roundNumber})`
            : match.map,
        );
      }
    }
    for (const entry of Array.isArray(parsed.featuredMatches) ? parsed.featuredMatches : []) {
      const match = entry as { matchId?: unknown; title?: unknown };
      if (
        typeof match.matchId === "string" &&
        typeof match.title === "string" &&
        !labels.has(match.matchId)
      ) {
        labels.set(match.matchId, match.title);
      }
    }
  } catch {
    // No read-model yet, malformed, or unreadable — every caller falls
    // back to the raw match id, never a broken report page.
  }
  return labels;
}
app.get("/beta", (req, res) => {
  const returnTo = normalizeProxyWarBetaReturnTo(queryParam(req.query.next));
  if (!betaAccess.enabled) {
    res.redirect("/public");
    return;
  }
  if (hasValidBetaSession(req)) {
    res.redirect(returnTo);
    return;
  }
  res
    .type("html")
    .send(renderProxyWarBetaLoginHtml(betaAccess, undefined, returnTo));
});

app.get("/api/beta/login", (req, res) => {
  const returnTo = normalizeProxyWarBetaReturnTo(queryParam(req.query.next));
  res.redirect(`/beta?next=${encodeURIComponent(returnTo)}`);
});

app.post("/api/beta/login", (req, res) => {
  if (!enforceRateLimit("beta-login", rateLimits.betaLogin, req, res)) {
    return;
  }
  if (!betaAccess.enabled) {
    res.redirect("/public");
    return;
  }
  const inviteCode = inviteCodeFromBody(req.body as Record<string, unknown>);
  const returnTo = normalizeProxyWarBetaReturnTo(
    returnToFromBody(req.body as Record<string, unknown>),
  );
  if (!verifyProxyWarBetaInviteCode(betaAccess, inviteCode)) {
    res
      .status(401)
      .type("html")
      .send(
        renderProxyWarBetaLoginHtml(
          betaAccess,
          betaAccess.inviteCode === null
            ? "The beta invite code is not configured on this server."
            : "That invite code did not work.",
          returnTo,
        ),
      );
    return;
  }
  const token = createProxyWarBetaSessionToken({ inviteCode });
  res.setHeader("Set-Cookie", betaSessionCookieHeader(betaAccess, token));
  res.redirect(returnTo);
});

app.post("/api/beta/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearBetaSessionCookieHeader(betaAccess));
  res.redirect("/beta");
});

app.get("/agent-start", async (_req, res, next) => {
  try {
    const model = await loadAgentDemoHubModel({
      runsRootDir,
      tournamentsRootDir,
      evaluationsRootDir,
      rendererBaseUrl,
      jobs: recentJobs(),
      nationsDir: nationsRootDir,
      houseAgentBrain,
      closedBeta: betaAccess.enabled
        ? { enabled: true, label: betaAccess.label }
        : undefined,
    });
    res.type("html").send(renderProxyWarAgentStartHtml(model));
  } catch (error) {
    next(error);
  }
});

app.get("/agent-start.json", async (_req, res, next) => {
  try {
    const model = await loadAgentDemoHubModel({
      runsRootDir,
      tournamentsRootDir,
      evaluationsRootDir,
      rendererBaseUrl,
      jobs: recentJobs(),
      nationsDir: nationsRootDir,
      houseAgentBrain,
      closedBeta: betaAccess.enabled
        ? { enabled: true, label: betaAccess.label }
        : undefined,
    });
    res.json(proxyWarAgentStartJson(model));
  } catch (error) {
    next(error);
  }
});

app.get("/protocol/proxywar-agent.schema.json", (_req, res) => {
  res.json(proxyWarAgentProtocolSchema());
});

app.get("/agent-start.sh", serveProxyWarAgentBootstrapScript);
app.get("/docs/:artifact", servePublicDoc);
app.get("/examples/external-agent/:artifact", servePublicExternalAgentExample);

app.get("/api/agent-relay/sessions/:sessionID/poll", async (req, res) => {
  if (!agentRelayGuard.enforceRequestRate(req, res)) {
    return;
  }
  const releasePollSlot = agentRelayGuard.acquirePollSlot(req, res);
  if (releasePollSlot === null) {
    return;
  }
  try {
    await restoreSavedRelaySessionIfPossible(
      req.params.sessionID,
      bearerToken(req),
    );
    const result = await agentRelay.poll({
      sessionID: req.params.sessionID,
      token: bearerToken(req),
      waitMs: optionalPositiveInt(queryParam(req.query.waitMs)),
    });
    res.json(result);
  } catch (error) {
    sendRelayError(res, error);
  } finally {
    releasePollSlot();
  }
});

app.post("/api/agent-relay/sessions/:sessionID/decisions", (req, res) => {
  if (!agentRelayGuard.enforceRequestRate(req, res)) {
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const result = agentRelay.submitDecision({
      sessionID: req.params.sessionID,
      token: bearerToken(req),
      requestID: typeof body.requestID === "string" ? body.requestID : "",
      response: body,
    });
    res.json({ ok: true, requestID: result.requestID });
  } catch (error) {
    sendRelayError(res, error);
  }
});

app.post("/api/agent-relay/sessions/:sessionID/requests", async (req, res) => {
  if (!agentRelayGuard.enforceRequestRate(req, res)) {
    return;
  }
  try {
    await restoreSavedRelaySessionIfPossible(
      req.params.sessionID,
      bearerToken(req),
    );
    const body = req.body as Record<string, unknown>;
    const result = await agentRelay.requestDecision({
      sessionID: req.params.sessionID,
      token: bearerToken(req),
      request: normalizeRelayDecisionRequest(body.request ?? body),
      timeoutMs: optionalPositiveInt(body.timeoutMs),
    });
    res.json({
      ok: true,
      requestID: result.requestID,
      responseText: result.responseText,
    });
  } catch (error) {
    sendRelayError(res, error);
  }
});

app.use((req, res, next) => {
  if (!betaAccess.enabled || hasValidBetaSession(req)) {
    next();
    return;
  }
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    (isProxyWarPublicLeaguePath(req.path) ||
      isProxyWarPublicPremiereReadPath(req.path) ||
      isProxyWarPublicRendererAssetPath(req.path) ||
      leagueClipPublicReadAllowed(req.path))
  ) {
    next();
    return;
  }
  if (
    req.method === "POST" &&
    (isProxyWarPublicPremiereWritePath(req.path) ||
      leagueClipPublicWriteAllowed(req.path))
  ) {
    next();
    return;
  }
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Proxy War beta invite required" });
    return;
  }
  res.redirect(`/beta?next=${encodeURIComponent(req.originalUrl)}`);
});

// League-run clip surface. Mounted after the wrapper/beta gates (which admit
// only mirror-published league-* keys anonymously) and BEFORE the run-artifact
// handlers so clip-v1-<bucket>.mp4 never falls into the artifact allowlist.
if (aiLeagueRunClips !== null) {
  const runClips = aiLeagueRunClips;
  app.use(
    createAiLeagueRunClipDocumentRouter({
      runClips,
      onOperatorError: (error) => {
        console.error(
          `League run clip route failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    }),
  );
  app.use((req, res, next) => {
    const read = matchProxyWarLeagueClipReadPath(req.path);
    if (
      read?.kind === "clip_status" &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      void runClips
        .readRunClipStatus({
          runKey: read.runKey,
          bucket: read.bucket,
          // Explicit opt-in keeps the default schema-v1 body compatible with
          // already-cached strict clients. Repeated/ambiguous values fail
          // closed to the legacy response shape.
          includeProgress: req.query.progress === "1",
        })
        .then((status) => {
          if (status.state === "absent") {
            res
              .status(404)
              .json({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } });
            return;
          }
          res.json(status);
        })
        .catch((error: unknown) => {
          const mapped = aiLeagueRunClipErrorBody(error);
          res.status(mapped.status).json(mapped.body);
        });
      return;
    }
    const write = matchProxyWarLeagueClipWritePath(req.path);
    if (write !== null && req.method === "POST") {
      // Canary mode has no public write path. Refuse before rate-limit state,
      // requester derivation, clip quota, disk probes, or worker admission.
      if (!aiLeagueRunClipsEnabled) {
        res.status(404).json({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } });
        return;
      }
      if (!enforceRateLimit("league-clips", rateLimits.leagueClips, req, res)) {
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const turn = typeof body.turn === "number" ? body.turn : Number.NaN;
      void runClips
        .requestRunClip({
          runKey: write.runKey,
          anchorTurn: turn,
          participantId: replayPremiereGuestSecurity.deriveRequesterBucketId(
            rateLimitKey(req),
          ),
        })
        .then((status) => {
          res.setHeader("Cache-Control", "no-store, max-age=0");
          res.json(status);
        })
        .catch((error: unknown) => {
          const mapped = aiLeagueRunClipErrorBody(error);
          res.status(mapped.status).json(mapped.body);
        });
      return;
    }
    next();
  });
}

// Bet-origin's own copy of the league mirror (this route's static file,
// plus its `/ai-league-runs/league*` and `/runs/league*` aliases below,
// which resolve to the identical file) is a byte-for-byte snapshot from
// whenever this deploy's clone was checked out. `cycle-premiere.sh`'s
// `refresh_league_data` keeps only the STANDINGS JSON current every cycle;
// the HTML shell's baked `generated-at`/`data-stale="false"` attributes are
// never touched, so a visitor can land on a confidently "LIVE" page that
// silently stopped advancing weeks ago (found live 2026-08-02: bet's copy
// frozen at 2026-07-27T12:04:13Z while beta had already moved on).
// Product separation: a league standings PAGE belongs on the league
// origin, not a wagering mirror — redirect a real visitor there instead of
// trying to keep a second copy fresh forever.
//
// Deliberately narrow, not a blanket redirect on these paths:
//  - `pointsRoutesEnabled` is this file's own established signal for "this
//    is the wagering/bet origin" (see the points-leaderboard gate above);
//    beta and the platform apex keep their OWN mirrors fresh via separate
//    launchd refreshers (RUNBOOK §16.1) and must never be redirected here.
//  - `isTrustedLocalRelayRequest` excludes a request that genuinely never
//    left the box (no Cloudflare forwarding headers), so a local tester
//    hitting 127.0.0.1:<port>/league directly still sees their own build.
//  - `Sec-Fetch-Dest: document` (sent by every real browser navigation,
//    never by curl or Node's fetch/undici) is the condition that actually
//    matters in production. Two internal safety checks require this exact
//    path to answer 200 with real content and cannot be pointed anywhere
//    else: `wait_for_origin` (cycle-premiere.sh) and `restartReadyUrl`
//    (replay-premiere-loop.ts) poll it over loopback to confirm a restart
//    landed (already covered by the trusted-local check above — this is
//    belt-and-suspenders for them), but replay-premiere-admit.ts's
//    leak-audit collector fetches this exact URL over the PUBLIC origin
//    with `redirect: "error"` as a wagering safety check, and
//    `assertProductionLeakAuditOrigin`
//    (ReplayPremiereCheckpointProjectionStore.ts) pins every leak-audit
//    target to this single deployment origin — there is no second origin
//    to point that check at instead. A blanket redirect here would fail
//    every premiere admission with `collector_redirect_rejected` and take
//    the market down (confirmed by reading the collector's `redirect:
//    "error"` fetch mode, not merely inferred).
function isCopiedLeagueMirrorPagePath(requestPath: string): boolean {
  return (
    requestPath === "/league" ||
    requestPath === "/runs/league" ||
    requestPath === "/runs/league/" ||
    requestPath.startsWith("/runs/league/") ||
    requestPath === "/ai-league-runs/league" ||
    requestPath === "/ai-league-runs/league/" ||
    requestPath.startsWith("/ai-league-runs/league/")
  );
}
app.use((req, res, next) => {
  if (
    !pointsRoutesEnabled ||
    (req.method !== "GET" && req.method !== "HEAD") ||
    !isCopiedLeagueMirrorPagePath(req.path) ||
    isTrustedLocalRelayRequest(req) ||
    req.headers["sec-fetch-dest"] !== "document"
  ) {
    next();
    return;
  }
  res.redirect(302, platformLeagueHomeUrl);
});

app.get("/league", (req, res) => {
  res.setHeader("Content-Security-Policy", leagueContentSecurityPolicy());
  sendPublicArtifactFile(
    req,
    res,
    path.join("league", "index.html"),
    "league page not generated yet",
    { root: runsRootDir },
  );
});

if (betaAccess.enabled) {
  app.get("/docs/:artifact", servePublicDoc);
  app.get(
    "/examples/external-agent/:artifact",
    servePublicExternalAgentExample,
  );
  app.get("/runs/:runID/:artifact", servePublicRunArtifact);
  app.get("/ai-league-runs/:runID/:artifact", servePublicRunArtifact);
  app.get(
    "/tournaments/:tournamentID/:artifact",
    servePublicTournamentArtifact,
  );
} else {
  const leagueIndexRelativePath = path
    .join("league", "index.html")
    .toLocaleLowerCase("en-US");
  const setRunArtifactHeaders = (res: Response, filePath: string): void => {
    const relativePath = path
      .relative(runsRootDir, path.resolve(filePath))
      .toLocaleLowerCase("en-US");
    if (relativePath === leagueIndexRelativePath) {
      res.setHeader("Content-Security-Policy", leagueContentSecurityPolicy());
    }
  };
  app.get("/docs/:artifact", servePublicDoc);
  app.get(
    "/examples/external-agent/:artifact",
    servePublicExternalAgentExample,
  );
  app.use(
    "/runs",
    express.static(runsRootDir, {
      extensions: ["html"],
      setHeaders: setRunArtifactHeaders,
    }),
  );
  app.use(
    "/ai-league-runs",
    express.static(runsRootDir, {
      extensions: ["html"],
      setHeaders: setRunArtifactHeaders,
    }),
  );
  app.use(
    "/tournaments",
    express.static(tournamentsRootDir, { extensions: ["html"] }),
  );
  app.use(
    "/evaluations",
    express.static(evaluationsRootDir, { extensions: ["html"] }),
  );
}

if (leagueWrapperOnly) {
  app.get("/ai-league-replay/:runID", async (req, res) => {
    if (!isProxyWarPublicLeaguePath(req.path)) {
      sendThemedNotFoundPage(res, 404, "AI league replay record not found.");
      return;
    }
    const runID = stringParam(req.params.runID);
    const gameRecordPath = path.resolve(runsRootDir, runID, "game-record.json");
    if (
      !isInsideRoot(gameRecordPath, runsRootDir) ||
      !(await ensureRenderableGameRecordPath(runID, gameRecordPath))
    ) {
      res.redirect("/league");
      return;
    }
    try {
      const content = await getAppShellContent(
        path.resolve(staticRootDir, "index.html"),
      );
      setHtmlNoCacheHeaders(res);
      res.send(content);
    } catch (error) {
      console.error(
        `Failed to serve the built replay client: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      res
        .status(503)
        .send("Proxy War replay client is not built for this server.");
    }
  });

  const serveBuiltRendererAsset = express.static(staticRootDir, {
    fallthrough: true,
    setHeaders: (res) => {
      applyStaticAssetCacheControl(
        res.setHeader.bind(res),
        res.req.originalUrl,
      );
    },
  });
  app.use((req, res, next) => {
    if (!isProxyWarPublicRendererAssetPath(req.path)) {
      next();
      return;
    }
    serveBuiltRendererAsset(req, res, next);
  });
} else {
  for (const prefix of rendererProxyPrefixes()) {
    app.use(prefix, proxyRendererRequest);
  }
}

app.get("/", async (_req, res, next) => {
  if (platformEnabled) {
    res.type("html").send(
      renderPlatformRootHtml({
        leagueUrl: platformLeagueHomeUrl,
        replaysUrl: platformReplaysHomeUrl,
        marketUrl: platformMarketHomeUrl,
        githubSignInAvailable: githubOAuthConfig !== null,
      }),
    );
    return;
  }
  if (betaAccess.enabled) {
    res.redirect("/public");
    return;
  }
  try {
    const model = await loadAgentDemoHubModel({
      runsRootDir,
      tournamentsRootDir,
      evaluationsRootDir,
      rendererBaseUrl,
      jobs: recentJobs(),
      nationsDir: nationsRootDir,
      houseAgentBrain,
      closedBeta: betaAccess.enabled
        ? { enabled: true, label: betaAccess.label }
        : undefined,
    });
    res.type("html").send(renderAgentDemoHubHtml(model));
  } catch (error) {
    next(error);
  }
});

app.get("/public", async (_req, res, next) => {
  try {
    const model = await loadAgentDemoHubModel({
      runsRootDir,
      tournamentsRootDir,
      evaluationsRootDir,
      rendererBaseUrl,
      jobs: recentJobs(),
      nationsDir: nationsRootDir,
      houseAgentBrain,
      closedBeta: betaAccess.enabled
        ? { enabled: true, label: betaAccess.label }
        : undefined,
    });
    res.type("html").send(renderProxyWarPublicHtml(model));
  } catch (error) {
    next(error);
  }
});

// Zero-install tester entry point: write a strategy, a sponsored LLM agent plays it.
app.get("/play", (_req, res) => {
  res.type("html").send(
    renderQuickStartPlayHtml({
      replayPathPrefix: "/proxywar-replay",
      betaLabel: betaAccess.enabled ? betaAccess.label : "Beta",
    }),
  );
});

app.get("/tester-dashboard", async (_req, res, next) => {
  try {
    const model = await loadAgentDemoHubModel({
      runsRootDir,
      tournamentsRootDir,
      evaluationsRootDir,
      rendererBaseUrl,
      jobs: recentJobs(),
      nationsDir: nationsRootDir,
      houseAgentBrain,
      closedBeta: betaAccess.enabled
        ? { enabled: true, label: betaAccess.label }
        : undefined,
    });
    res.type("html").send(
      renderProxyWarTesterDashboardHtml({
        hub: model,
        server: {
          betaEnabled: betaAccess.enabled,
          rendererBaseUrl,
          publicReadiness: await loadPublicReadinessReport(model),
          runningJobID,
          queuedJobCount: queuedJobIDs.length,
          maxQueuedJobs,
          rateLimitBucketCount: rateLimiter.snapshot().buckets.length,
          rateLimits,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/admin", async (_req, res, next) => {
  if (betaAccess.enabled && !betaAdminEnabled) {
    res.status(404).send("admin not available in shared beta mode");
    return;
  }
  try {
    const model = await loadAgentDemoHubModel({
      runsRootDir,
      tournamentsRootDir,
      evaluationsRootDir,
      rendererBaseUrl,
      jobs: recentJobs(),
      nationsDir: nationsRootDir,
      houseAgentBrain,
      closedBeta: betaAccess.enabled
        ? { enabled: true, label: betaAccess.label }
        : undefined,
    });
    res.type("html").send(
      renderProxyWarAdminHtml({
        hub: model,
        server: {
          betaEnabled: betaAccess.enabled,
          rendererBaseUrl,
          publicReadiness: await loadPublicReadinessReport(model),
          runningJobID,
          queuedJobCount: queuedJobIDs.length,
          maxQueuedJobs,
          rateLimitBucketCount: rateLimiter.snapshot().buckets.length,
          rateLimits,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/status", (_req, res) => {
  if (betaAccess.enabled && !betaAdminEnabled) {
    res.status(404).json({ error: "status not available in shared beta mode" });
    return;
  }
  res.json({
    ok: true,
    jobCount: jobs.size,
    runningJobID,
    queuedJobCount: queuedJobIDs.length,
    maxQueuedJobs,
    rendererBaseUrl,
    betaEnabled: betaAccess.enabled,
    rateLimitBucketCount: rateLimiter.snapshot().buckets.length,
    rateLimits,
  });
});

app.get("/api/public-readiness", async (_req, res, next) => {
  try {
    res.json(await loadPublicReadinessReport());
  } catch (error) {
    next(error);
  }
});
app.get("/api/tester-dashboard", async (_req, res, next) => {
  try {
    const model = await loadAgentDemoHubModel({
      runsRootDir,
      tournamentsRootDir,
      evaluationsRootDir,
      rendererBaseUrl,
      jobs: recentJobs(),
      nationsDir: nationsRootDir,
      houseAgentBrain,
      closedBeta: betaAccess.enabled
        ? { enabled: true, label: betaAccess.label }
        : undefined,
    });
    const latestRun =
      model.runs.find((run) => run.hasOpenFrontReplay) ?? model.runs[0];
    res.json({
      ok: true,
      queue: {
        running: runningJobID !== null,
        queuedJobCount: queuedJobIDs.length,
        maxQueuedJobs,
        activeJob:
          recentJobs().find(
            (job) => job.status === "running" || job.status === "queued",
          ) ?? null,
      },
      latestRun:
        latestRun === undefined
          ? null
          : {
              runID: latestRun.runID,
              replayUrl: latestRun.hasOpenFrontReplay
                ? `/proxywar-replay/${encodeURIComponent(latestRun.runID)}`
                : null,
              matchPackageUrl: latestRun.hasMatchPackage
                ? `/runs/${encodeURIComponent(latestRun.runID)}/${latestRun.matchPackageLinkFileName}`
                : null,
              feedbackUrl: latestRun.hasExternalFeedback
                ? `/runs/${encodeURIComponent(latestRun.runID)}/external-agent-feedback.md`
                : null,
              decisionCount: latestRun.decisionCount,
              acceptedCount: latestRun.acceptedCount,
              rejectedCount: latestRun.rejectedCount,
              postSpawnNonHoldActionCount:
                latestRun.postSpawnNonHoldActionCount,
            },
      savedAgents: model.savedNations.map((nation) => ({
        nationID: nation.nationID,
        agentName: nation.agentName,
        profile: nation.profile,
        provider: nation.provider?.provider ?? "manifest",
        createdAt: nation.createdAt,
      })),
      publicReadiness: await loadPublicReadinessReport(model),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tester-dashboard/endpoint-health", async (req, res) => {
  if (
    !enforceRateLimit(
      "external-agent-check",
      rateLimits.externalCheck,
      req,
      res,
    )
  ) {
    return;
  }
  try {
    const nations = await listProxyWarNations(nationsRootDir);
    const externalNations = nations.filter(
      (nation) =>
        nation.provider?.provider === "external-http" ||
        nation.provider?.provider === "external-relay",
    );
    const results = [];
    for (const nation of externalNations) {
      const provider = nation.provider;
      if (provider?.provider === "external-relay") {
        const live = agentRelay.hasActiveSession(
          provider.sessionID,
          relayActiveIdleMs,
        );
        results.push({
          nationID: nation.nationID,
          agentName: nation.agentName,
          profile: nation.profile,
          ok: live,
          endpoint: relaySessionLabel(
            provider.relayBaseUrl,
            provider.sessionID,
          ),
          latencyMs: 0,
          ...(live
            ? {
                selectedLegalActionId: "live relay session",
                reason: "Managed relay worker session is active.",
              }
            : {
                failureReason: "managed relay session is not active",
                fixHint:
                  "Rerun the /agent-start.sh bootstrap command so the tester worker creates a fresh relay session.",
              }),
        });
        continue;
      }
      if (provider?.provider !== "external-http") continue;
      try {
        const result = await checkExternalAgentEndpoint(
          normalizeExternalAgentHealthCheckInput({
            endpointUrl: provider.endpointUrl,
            token: proxyWarProviderTokenInput(provider),
            timeoutMs: provider.timeoutMs,
            allowTokenReferences: true,
          }),
        );
        results.push({
          nationID: nation.nationID,
          agentName: nation.agentName,
          profile: nation.profile,
          ok: result.ok,
          endpoint: result.endpoint,
          latencyMs: result.latencyMs,
          selectedLegalActionId: result.selectedLegalActionId,
          reason: result.reason,
          confidence: result.confidence,
          failureReason: result.failureReason,
          fixHint: result.fixHint,
        });
      } catch (error) {
        results.push({
          nationID: nation.nationID,
          agentName: nation.agentName,
          profile: nation.profile,
          ok: false,
          endpoint: endpointLabel(provider.endpointUrl),
          latencyMs: 0,
          failureReason:
            error instanceof Error ? error.message : "endpoint check failed",
        });
      }
    }
    res.json({ ok: true, checkedAt: new Date().toISOString(), results });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "endpoint health failed",
    });
  }
});

app.post("/api/agent-relay/sessions", async (req, res) => {
  if (!enforceRateLimit("nations", rateLimits.nations, req, res)) {
    return;
  }

  try {
    const body = req.body as Record<string, unknown>;
    const queueMatch = body.queueMatch !== false;
    if (queueMatch) {
      if (!enforceRateLimit("jobs", rateLimits.jobs, req, res)) {
        return;
      }
      if (runningJobID !== null && queuedJobIDs.length >= maxQueuedJobs) {
        res.status(429).json({
          ok: false,
          error:
            "The Proxy War demo queue is full. Wait for the current jobs to finish and try again.",
          runningJobID,
          queuedJobCount: queuedJobIDs.length,
        });
        return;
      }
    }
    const agentName = cleanRelayAgentName(body.agentName);
    const profile = cleanRelayProfile(body.profile);
    const doctrine = cleanRelayDoctrine(body.doctrine);
    const timeoutMs = optionalPositiveInt(body.timeoutMs) ?? 120_000;
    const relay = agentRelay.createSession({
      agentName,
      profile,
      relayBaseUrl: publicOriginForRequest(req),
    });
    const saved = await saveProxyWarNation(
      {
        agentName,
        profile,
        doctrine,
        personality:
          typeof body.personality === "string" && body.personality.trim() !== ""
            ? body.personality
            : "Managed relay starter agent. It receives canonical Proxy War decision requests over outbound polling.",
        policyChangelog:
          typeof body.policyChangelog === "string" ? body.policyChangelog : "",
        agentMode: "external-relay",
        relayBaseUrl: relay.relayBaseUrl,
        relaySessionID: relay.sessionID,
        relayToken: relay.sessionToken,
        relayTimeoutMs: timeoutMs,
      },
      { nationsDir: nationsRootDir },
    );
    const activeRoster = await syncProxyWarActiveRoster({
      nationsDir: nationsRootDir,
      pinnedNationID: saved.nation.nationID,
      maxSavedNations: 1,
      includeCuratedDefaults: false,
      minRosterSize: 1,
    });
    const request = normalizeAgentDemoJobRequest({
      ...proxyWarTesterSavedRosterJobDefaults,
      brain: houseAgentBrain,
    });
    const queued = queueMatch ? enqueueProxyWarJob(request) : null;
    if (queued?.ok === false) {
      agentRelay.closeSession({
        sessionID: relay.sessionID,
        token: relay.sessionToken,
      });
      res.status(429).json({
        ok: false,
        error: queued.error,
        runningJobID,
        queuedJobCount: queuedJobIDs.length,
      });
      return;
    }

    res.status(queueMatch ? 202 : 201).json({
      ok: true,
      relay,
      nation: {
        nationID: saved.nation.nationID,
        agentName: saved.nation.agentName,
        profile: saved.nation.profile,
        fileName: saved.nation.fileName,
      },
      activeRosterCount: activeRoster.length,
      jobRequest: request,
      ...(queued?.ok === true
        ? {
            jobID: queued.job.jobID,
            label: queued.job.label,
            status: queued.job.status,
            jobStatusUrl: `/api/jobs/${encodeURIComponent(queued.job.jobID)}`,
          }
        : {}),
    });
  } catch (error) {
    sendRelayError(res, error);
  }
});

app.post("/api/jobs", async (req, res) => {
  if (!enforceRateLimit("jobs", rateLimits.jobs, req, res)) {
    return;
  }
  try {
    const request = normalizeAgentDemoJobRequest(
      req.body as Record<string, unknown>,
    );
    if (request.roster === "saved") {
      const activeRoster = await syncProxyWarActiveRoster({
        nationsDir: nationsRootDir,
        maxSavedNations: request.maxSavedNations,
        includeCuratedDefaults: request.fillSavedRoster !== false,
        minRosterSize: request.fillSavedRoster === false ? 1 : undefined,
      });
      await assertProxyWarActiveRosterExternalEndpointsHealthy(activeRoster, {
        relaySessionExists: (sessionID) =>
          agentRelay.hasActiveSession(sessionID, relayActiveIdleMs),
      });
    }
    const queued = enqueueProxyWarJob(request);
    if (!queued.ok) {
      res.status(429).json({
        error: queued.error,
        runningJobID,
        queuedJobCount: queuedJobIDs.length,
      });
      return;
    }

    res.status(202).json({
      jobID: queued.job.jobID,
      label: queued.job.label,
      status: queued.job.status,
    });
  } catch (error) {
    res
      .status(error instanceof ProxyWarActiveRosterHealthError ? 422 : 400)
      .json({
        ok: false,
        error: error instanceof Error ? error.message : "invalid job request",
        ...(error instanceof ProxyWarActiveRosterHealthError
          ? { health: error.report }
          : {}),
      });
  }
});

// Public quick-start: the zero-install tester path. The tester only supplies a
// strategy spec; the brain (sponsored openrouter/deepseek seat), opponents
// (built-in nations), and bounded size are LOCKED here so the public endpoint can
// never request an expensive brain or oversized match.
app.post("/api/quick-start", async (req, res) => {
  if (!enforceRateLimit("jobs", rateLimits.jobs, req, res)) {
    return;
  }
  const hasOpenRouterKey =
    (
      process.env.AI_LEAGUE_OPENROUTER_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      ""
    ).trim() !== "";
  if (!hasOpenRouterKey) {
    res.status(503).json({
      ok: false,
      error:
        "Sponsored quick-start play is not configured on this server yet (no OpenRouter key).",
    });
    return;
  }
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const maxSteps = Number(process.env.PROXYWAR_QUICK_START_MAX_STEPS ?? "40");
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner-openrouter",
      scenario: "actions",
      roster: "default",
      matchLength: "showcase",
      agents: 1,
      // Crowded board (5 built-in opponents) forces early contact so the player's
      // strategy visibly diverges — a spacious 2-player board is all opening
      // land-grab where every playstyle looks the same.
      bots: 2,
      nations: 3,
      difficulty: "Easy",
      // ~40 decision steps so nations make contact and the strategy actually plays
      // out (expansion -> war/alliances) instead of ending in the opening land-grab.
      maxSteps: Number.isInteger(maxSteps) ? maxSteps : 40,
      requireWinner: false,
      replayTailTurns: 1500,
      // The tester's chosen name -> the sponsored agent's in-game username.
      agentName:
        typeof body.agentName === "string" ? body.agentName : undefined,
      strategySpec: body.strategySpec ?? {},
    });
    const queued = enqueueProxyWarJob(request);
    if (!queued.ok) {
      res.status(429).json({
        ok: false,
        error: queued.error,
        runningJobID,
        queuedJobCount: queuedJobIDs.length,
      });
      return;
    }
    res.status(202).json({
      jobID: queued.job.jobID,
      label: queued.job.label,
      status: queued.job.status,
      jobStatusUrl: `/api/jobs/${encodeURIComponent(queued.job.jobID)}`,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error:
        error instanceof Error ? error.message : "invalid quick-start request",
    });
  }
});

// ---------------------------------------------------------------------------
// Lobby: shared 4-agent matches. Players join with a prompt and wait; when 4
// have joined, the lobby seals and ONE match runs with all 4 agents — each
// driven by its joiner's prompt via a per-seat manifest — and all 4 poll the
// same result. Strict fill: a match never starts until 4 real players join.
// ---------------------------------------------------------------------------
const LOBBY_SIZE = 4;
type LobbyStatus = "waiting" | "starting" | "running" | "completed" | "failed";
interface LobbyMember {
  token: string;
  agentName: string;
  strategySpec: PlayerStrategySpec;
  /** True for an auto-filled house agent (not a human joiner). */
  isHouse?: boolean;
}
interface ProxyWarLobby {
  id: string;
  members: LobbyMember[];
  status: LobbyStatus;
  jobID: string | null;
  error: string | null;
  /** Grace-window timer: when the first human joins we wait briefly for others,
   *  then auto-fill remaining seats with house agents and start. */
  startTimer?: ReturnType<typeof setTimeout> | null;
  /** Cached {standings, story} read once from the run's drama-report.json on completion. */
  result?: Record<string, unknown> | null;
}

// Empty lobby seats are filled with real LLM house agents (planner-executor brain +
// a fixed strategySpec — NEVER deterministic fillers) so a match starts promptly
// instead of waiting for four humans. HOUSE_CHAMPION_NAME is the fixed benchmark to
// beat; the /play result card detects it by this exact name (keep them in sync).
const HOUSE_CHAMPION_NAME = "Proxy Champion";
const LOBBY_GRACE_MS = Number(process.env.PROXYWAR_LOBBY_GRACE_MS ?? "25000");
const HOUSE_AGENTS: { agentName: string; strategySpec: PlayerStrategySpec }[] =
  [
    {
      agentName: HOUSE_CHAMPION_NAME,
      strategySpec: {
        posture: "aggressive",
        objectiveBias: "expand",
        doctrine:
          "Expand relentlessly into open land and take territory from the weakest neighbor you can reach. Never sit idle — always be expanding or pressing an attack. Hold at most ONE alliance of convenience and break it the moment you can seize the ally's land; do not over-ally or you will be ganged up on. Avoid fighting two strong powers at once: pick off the weak first, then turn on the strong.",
      },
    },
    {
      agentName: "Ironwall",
      strategySpec: {
        posture: "defensive",
        objectiveBias: "economy",
        doctrine:
          "Build a dominant economy — cities first, then factories and ports. Fortify borders and only fight when attacked or when a neighbor is clearly weaker on your border. Win on production and late-game troop mass.",
      },
    },
    {
      agentName: "Coalition",
      strategySpec: {
        posture: "diplomatic",
        objectiveBias: "diplomacy",
        doctrine:
          "Ally widely and early, back allies with gold, and turn the lobby against whoever is in the lead. Avoid first strikes; let rivals bleed each other, then take the spoils.",
      },
    },
  ];
let formingLobby: ProxyWarLobby | null = null;
const lobbiesById = new Map<string, ProxyWarLobby>();

function currentFormingLobby(): ProxyWarLobby {
  if (formingLobby === null) {
    const lobby: ProxyWarLobby = {
      id: randomUUID(),
      members: [],
      status: "waiting",
      jobID: null,
      error: null,
    };
    formingLobby = lobby;
    lobbiesById.set(lobby.id, lobby);
  }
  return formingLobby;
}

function lobbyProfileForSpec(
  spec: PlayerStrategySpec,
): "aggressive" | "defensive" | "diplomatic" | "opportunistic" {
  const posture = spec.posture;
  return posture === "aggressive" ||
    posture === "defensive" ||
    posture === "diplomatic"
    ? posture
    : "opportunistic";
}

async function startLobbyMatch(lobby: ProxyWarLobby): Promise<void> {
  lobby.status = "starting";
  if (lobby.startTimer) {
    clearTimeout(lobby.startTimer);
    lobby.startTimer = null;
  }
  // Fill any empty seats with real LLM house agents (Champion first) so the match
  // runs without waiting for four humans. House agents are planner-executor LLM
  // agents with fixed strategySpecs — not deterministic fillers.
  for (let i = 0; lobby.members.length < LOBBY_SIZE; i++) {
    const house = HOUSE_AGENTS[i % HOUSE_AGENTS.length];
    lobby.members.push({
      token: randomUUID(),
      agentName: house.agentName,
      strategySpec: house.strategySpec,
      isHouse: true,
    });
  }
  try {
    const dir = path.join(artifactsRootDir, "lobby", lobby.id);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      lobby.members.map((member, index) => {
        const manifest = {
          schemaVersion: 1 as const,
          agentName: member.agentName,
          profile: lobbyProfileForSpec(member.strategySpec),
          brainType: "planner-executor" as const,
          strategySpec: member.strategySpec,
        };
        return fs.writeFile(
          path.join(dir, `agent-${index + 1}.json`),
          JSON.stringify(manifest, null, 2),
          "utf8",
        );
      }),
    );
    // 4 agents run ~4x the planner calls of a solo match, so the per-agent step
    // budget is lower to keep the shared match watchably short (env-tunable).
    const maxSteps = Number(process.env.PROXYWAR_LOBBY_MAX_STEPS ?? "12");
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner-openrouter",
      scenario: "actions",
      roster: "manifest",
      agentManifestDir: dir,
      matchLength: "showcase",
      // No explicit `agents` count: that makes the smoke ADD house agents on top
      // of the manifests (seats 8, not 4). With roster=manifest the N manifests
      // ARE the players. No saved-roster fill either.
      fillSavedRoster: false,
      bots: 0,
      nations: 0,
      difficulty: "Easy",
      maxSteps: Number.isInteger(maxSteps) ? maxSteps : 12,
      turnsPerDecision: 50,
      requireWinner: false,
      replayTailTurns: 1500,
    });
    const queued = enqueueProxyWarJob(request);
    if (!queued.ok) {
      lobby.status = "failed";
      lobby.error = queued.error;
      return;
    }
    lobby.jobID = queued.job.jobID;
    lobby.status = "running";
  } catch (error) {
    lobby.status = "failed";
    lobby.error =
      error instanceof Error ? error.message : "lobby match failed to start";
  }
}

app.post("/api/lobby/join", (req, res) => {
  if (!enforceRateLimit("jobs", rateLimits.jobs, req, res)) {
    return;
  }
  const hasOpenRouterKey =
    (
      process.env.AI_LEAGUE_OPENROUTER_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      ""
    ).trim() !== "";
  if (!hasOpenRouterKey) {
    res.status(503).json({
      ok: false,
      error: "Sponsored play is not configured on this server yet.",
    });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  let strategySpec: PlayerStrategySpec;
  try {
    strategySpec = parsePlayerStrategySpec(body.strategySpec ?? {});
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "invalid strategy",
    });
    return;
  }
  const rawName =
    typeof body.agentName === "string" ? body.agentName.trim() : "";
  const agentName = (rawName === "" ? "Agent" : rawName).slice(0, 27);
  const lobby = currentFormingLobby();
  const token = randomUUID();
  lobby.members.push({ token, agentName, strategySpec });
  const sealed = lobby.members.length >= LOBBY_SIZE;
  res.status(202).json({
    lobbyId: lobby.id,
    token,
    slot: lobby.members.length,
    size: LOBBY_SIZE,
    status: sealed ? "starting" : "waiting",
  });
  if (sealed) {
    if (lobby.startTimer) clearTimeout(lobby.startTimer);
    formingLobby = null; // the next joiner forms a fresh lobby
    void startLobbyMatch(lobby);
  } else if (lobby.startTimer === null || lobby.startTimer === undefined) {
    // First human in a fresh lobby: open a grace window for other humans to join,
    // then auto-fill the remaining seats with house agents and start. Avoids the
    // cold-start trap where a match never begins because four humans never queue.
    lobby.startTimer = setTimeout(() => {
      if (lobby.status !== "waiting" || lobby.members.length === 0) {
        return;
      }
      if (formingLobby === lobby) {
        formingLobby = null;
      }
      void startLobbyMatch(lobby);
    }, LOBBY_GRACE_MS);
  }
});

function lobbyView(lobby: ProxyWarLobby): Record<string, unknown> {
  const base = {
    lobbyId: lobby.id,
    count: lobby.members.length,
    size: LOBBY_SIZE,
    agentNames: lobby.members.map((member) => member.agentName),
  };
  if (lobby.jobID) {
    const job = jobs.get(lobby.jobID);
    if (job?.status === "completed") {
      return {
        ...base,
        status: "completed",
        replayUrl: job.latestRunID
          ? `/proxywar-replay/${encodeURIComponent(job.latestRunID)}`
          : null,
      };
    }
    if (job?.status === "failed") {
      return {
        ...base,
        status: "failed",
        error: job.errorSummary ?? lobby.error,
      };
    }
    return { ...base, status: "running" };
  }
  return { ...base, status: lobby.status, error: lobby.error };
}

// Recent matches (most recent first) for the /play "Matches" panel — forming,
// in-progress, and completed lobbies tracked since the server started. NOTE:
// in-memory, so this list resets on a server restart (replays persist on disk).
app.get("/api/lobby/matches", (_req, res) => {
  const matches = [...lobbiesById.values()]
    .filter((lobby) => lobby.members.length > 0)
    .reverse()
    .slice(0, 20)
    .map(lobbyView);
  res.json({ matches });
});

// A finished match's result (standings + story) from the run's drama-report.json —
// a small file carrying both per-agent finalTilesOwned and the key moments.
async function readMatchResult(
  runID: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(
      path.join(runsRootDir, runID, "drama-report.json"),
      "utf8",
    );
    const d = JSON.parse(raw) as Record<string, unknown>;
    const agents = Array.isArray(d.agents)
      ? (d.agents as Record<string, unknown>[])
      : [];
    const standings = agents
      .slice()
      .sort(
        (a, b) =>
          ((b.finalTilesOwned as number) || 0) -
          ((a.finalTilesOwned as number) || 0),
      )
      .map((a) => ({
        name: a.username,
        tiles: (a.finalTilesOwned as number) || 0,
        alive: a.isAlive !== false,
        attacks: (a.attacksInitiated as number) || 0,
        alliances: (a.alliancesFormed as number) || 0,
        betrayals: (a.alliancesBroken as number) || 0,
      }));
    const moments = (Array.isArray(d.topMoments) ? d.topMoments : [])
      .slice()
      .sort(
        (a: Record<string, unknown>, b: Record<string, unknown>) =>
          ((a.turnNumber as number) || 0) - ((b.turnNumber as number) || 0),
      )
      .slice(0, 8)
      .map((m: Record<string, unknown>) => ({
        turn: (m.turnNumber as number) || 0,
        tone: (m.tone as string) || "",
        text:
          (m.message as string) ||
          `${(m.actor as string) || "?"} ${(m.kind as string) || ""}`.trim(),
      }));
    return {
      standings,
      story: {
        alliancesFormed: (d.allianceFormedCount as number) || 0,
        alliancesBroken: (d.allianceBrokenCount as number) || 0,
        betrayals: (d.betrayalCount as number) || 0,
        eliminations: (d.eliminationCount as number) || 0,
        grade: (d.dramaGrade as string) ?? null,
        moments,
      },
    };
  } catch {
    return null;
  }
}

app.get("/api/lobby/:lobbyId", async (req, res) => {
  const lobby = lobbiesById.get(req.params.lobbyId);
  if (!lobby) {
    res.status(404).json({ ok: false, error: "unknown lobby" });
    return;
  }
  const view = lobbyView(lobby);
  if (view.status === "completed" && lobby.result === undefined) {
    const job = lobby.jobID ? jobs.get(lobby.jobID) : null;
    lobby.result =
      typeof job?.latestRunID === "string"
        ? await readMatchResult(job.latestRunID)
        : null;
  }
  res.json({ ...view, result: lobby.result ?? null });
});

app.post("/api/nations", async (req, res) => {
  if (!enforceRateLimit("nations", rateLimits.nations, req, res)) {
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    await assertExternalEndpointInputAllowed(body);
    const result = await saveProxyWarNation(body, {
      nationsDir: nationsRootDir,
    });
    res.status(201).json({
      nation: {
        nationID: result.nation.nationID,
        agentName: result.nation.agentName,
        profile: result.nation.profile,
        personality: result.nation.personality,
        policyChangelog: result.nation.policyChangelog,
        skillPreferences: result.nation.skillPreferences,
        fileName: result.nation.fileName,
      },
      activeRosterCount: result.activeRoster.length,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "invalid nation",
    });
  }
});

app.delete("/api/nations/:nationID", async (req, res) => {
  if (!enforceRateLimit("nations", rateLimits.nations, req, res)) {
    return;
  }
  try {
    const result = await deleteProxyWarNation(req.params.nationID, {
      nationsDir: nationsRootDir,
    });
    res.json({
      ok: true,
      deletedNation: {
        nationID: result.deletedNation.nationID,
        agentName: result.deletedNation.agentName,
      },
      activeRosterCount: result.activeRoster.length,
    });
  } catch (error) {
    res.status(404).json({
      ok: false,
      error: error instanceof Error ? error.message : "saved nation not found",
    });
  }
});

app.post("/api/agent-cards/import", async (req, res) => {
  if (!enforceRateLimit("nations", rateLimits.nations, req, res)) {
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const cardInput = normalizeProxyWarAgentCardInput({
      cardUrl: body.cardUrl,
      timeoutMs: body.timeoutMs,
    });
    const card = await fetchAndParseProxyWarAgentCard(cardInput);
    await assertExternalEndpointInputAllowed(
      card.nationInput as Record<string, unknown>,
    );
    const result = await saveProxyWarNation(
      {
        ...card.nationInput,
        endpointToken: body.endpointToken,
      },
      { nationsDir: nationsRootDir },
    );
    res.status(201).json({
      ok: true,
      card: {
        cardUrl: card.cardUrl,
        title: card.title,
        warnings: card.warnings,
      },
      nation: {
        nationID: result.nation.nationID,
        agentName: result.nation.agentName,
        profile: result.nation.profile,
        personality: result.nation.personality,
        policyChangelog: result.nation.policyChangelog,
        skillPreferences: result.nation.skillPreferences,
        fileName: result.nation.fileName,
      },
      activeRosterCount: result.activeRoster.length,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "invalid agent card",
    });
  }
});

app.post("/api/agent-cards/import-and-run", async (req, res) => {
  if (!enforceRateLimit("nations", rateLimits.nations, req, res)) {
    return;
  }
  if (!enforceRateLimit("jobs", rateLimits.jobs, req, res)) {
    return;
  }
  if (runningJobID !== null && queuedJobIDs.length >= maxQueuedJobs) {
    res.status(429).json({
      ok: false,
      error:
        "The Proxy War demo queue is full. Wait for the current jobs to finish and try again.",
      runningJobID,
      queuedJobCount: queuedJobIDs.length,
    });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const cardInput = normalizeProxyWarAgentCardInput({
      cardUrl: body.cardUrl,
      timeoutMs: body.timeoutMs,
    });
    const card = await fetchAndParseProxyWarAgentCard(cardInput);
    await assertExternalEndpointInputAllowed(
      card.nationInput as Record<string, unknown>,
    );
    const health = await checkExternalAgentEndpoint(
      normalizeExternalAgentHealthCheckInput({
        endpointUrl: card.nationInput.endpointUrl,
        token: body.endpointToken,
        timeoutMs: card.nationInput.endpointTimeoutMs,
      }),
    );
    if (!health.ok) {
      const healthMessage = [
        health.failureReason ?? "external agent health check failed",
        health.fixHint,
      ]
        .filter(Boolean)
        .join(" Fix: ");
      res.status(422).json({
        ok: false,
        error: healthMessage,
        health,
      });
      return;
    }
    const result = await saveProxyWarNation(
      {
        ...card.nationInput,
        endpointToken: body.endpointToken,
      },
      { nationsDir: nationsRootDir },
    );
    const activeRoster = await syncProxyWarActiveRoster({
      nationsDir: nationsRootDir,
      pinnedNationID: result.nation.nationID,
      maxSavedNations: 1,
      includeCuratedDefaults: false,
      minRosterSize: 1,
    });
    const request = normalizeAgentDemoJobRequest({
      ...proxyWarTesterSavedRosterJobDefaults,
      brain: houseAgentBrain,
    });
    const queued = enqueueProxyWarJob(request);
    if (!queued.ok) {
      res.status(429).json({
        ok: false,
        error: queued.error,
        runningJobID,
        queuedJobCount: queuedJobIDs.length,
      });
      return;
    }
    res.status(202).json({
      ok: true,
      card: {
        cardUrl: card.cardUrl,
        title: card.title,
        warnings: card.warnings,
      },
      nation: {
        nationID: result.nation.nationID,
        agentName: result.nation.agentName,
        profile: result.nation.profile,
        fileName: result.nation.fileName,
      },
      activeRosterCount: activeRoster.length,
      health,
      jobID: queued.job.jobID,
      label: queued.job.label,
      status: queued.job.status,
      jobStatusUrl: `/api/jobs/${encodeURIComponent(queued.job.jobID)}`,
      replayUrl:
        queued.job.latestRunID === undefined
          ? null
          : `/proxywar-replay/${encodeURIComponent(queued.job.latestRunID)}`,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "invalid agent card import-and-run request",
    });
  }
});

app.post("/api/external-agents/check", async (req, res) => {
  if (
    !enforceRateLimit(
      "external-agent-check",
      rateLimits.externalCheck,
      req,
      res,
    )
  ) {
    return;
  }
  try {
    const checkInput = normalizeExternalAgentHealthCheckInput({
      endpointUrl: (req.body as Record<string, unknown>).endpointUrl,
      token: (req.body as Record<string, unknown>).endpointToken,
      timeoutMs: (req.body as Record<string, unknown>).endpointTimeoutMs,
    });
    const result = await checkExternalAgentEndpoint(checkInput);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "invalid external agent health check",
    });
  }
});

app.post("/api/external-agents/replay-decision", async (req, res) => {
  if (
    !enforceRateLimit(
      "external-agent-check",
      rateLimits.externalCheck,
      req,
      res,
    )
  ) {
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const input = normalizeExternalAgentReplaySandboxInput({
      endpointUrl: body.endpointUrl,
      token: body.endpointToken,
      timeoutMs: body.endpointTimeoutMs,
      runID: body.runID,
      sequence: body.sequence,
      runsRootDir,
    });
    const result = await replayExternalAgentDecision(input);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "invalid external agent replay sandbox request",
    });
  }
});

app.post("/api/beta/feedback", async (req, res) => {
  if (!enforceRateLimit("feedback", rateLimits.feedback, req, res)) {
    return;
  }
  try {
    const feedback = normalizeProxyWarBetaFeedback(
      req.body as Record<string, unknown>,
    );
    await fs.mkdir(betaFeedbackRootDir, { recursive: true });
    await fs.appendFile(betaFeedbackPath, `${JSON.stringify(feedback)}\n`);
    res.status(201).json({
      ok: true,
      feedbackID: feedback.feedbackID,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "invalid feedback",
    });
  }
});

app.get("/api/jobs/:jobID", (req, res) => {
  const job = jobs.get(req.params.jobID);
  if (job === undefined) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(jobResponse(job));
});

// "/openfront-replay" is the legacy path — previously published replay links
// must keep working. New links are emitted as "/proxywar-replay".
for (const replayRoute of [
  "/proxywar-replay/:runID",
  "/openfront-replay/:runID",
]) {
  app.get(replayRoute, async (req, res) => {
    const runID = String(req.params.runID);
    if (!isSafeProxyWarArtifactSegment(runID)) {
      sendThemedNotFoundPage(res, 404, "AI league replay record not found.");
      return;
    }
    // This is a bare redirect to the canonical /ai-league-replay/<runID>
    // URL — it must never issue that redirect for a run that doesn't
    // actually exist. A redirect from a supposedly-nonexistent alias is
    // indistinguishable, to any external prober (including the Replay
    // Premiere admission leak audit, which deliberately fetches an
    // `alternate_source_url` candidate with `redirect: "error"` and
    // expects a clean 404 for one that shouldn't resolve), from a real
    // leak: proof the run is reachable somewhere. Same existence check
    // `/ai-league-replay/:runID`'s own handler already uses.
    const gameRecordPath = path.resolve(runsRootDir, runID, "game-record.json");
    if (
      !isInsideRoot(gameRecordPath, runsRootDir) ||
      !(await ensureRenderableGameRecordPath(runID, gameRecordPath))
    ) {
      sendThemedNotFoundPage(res, 404, "AI league replay record not found.");
      return;
    }
    res.redirect(`/ai-league-replay/${encodeURIComponent(runID)}`);
  });
}

// Final catch-all: any request that reaches here matched no route or static
// file. Express's built-in fallback echoes the raw request path into the
// response body ("Cannot GET /..."), which fails the Replay Premiere leak
// audit for any URL constructed from a private sourceRunId (e.g. the
// `/ai-league-runs/league-<runId>/<artifact>` alias probe: it matches
// `isProxyWarPublicLeaguePath`'s generic "league-*" pattern and is let
// through to the static/artifact routes, which correctly 404 when no such
// run exists on disk — but without this handler that 404 falls through to
// Express's default, path-echoing page). Replace it with a fixed, path-free
// body for every method/route so no unmatched path ever appears in a
// response.
app.use((_req, res) => {
  res.status(404).send("Not found.");
});

const renderer = maybeStartRenderer();
const server = app.listen(port, host, () => {
  console.log(`Proxy War demo hub: ${serverUrls.localUrl}`);
  if (serverUrls.lanUrls.length > 0) {
    console.log(`LAN access: ${serverUrls.lanUrls.join(", ")}`);
  }
  if (serverUrls.publicUrl !== null) {
    console.log(`Public URL: ${serverUrls.publicUrl}`);
  }
  if (betaAccess.enabled) {
    console.log(`Proxy War closed beta: ${serverUrls.localUrl}/public`);
    console.log("Invite gate is enabled. The invite code is not printed.");
  }
  console.log(
    leagueWrapperOnly
      ? `Proxy War renderer: built client at ${staticRootDir}`
      : `Proxy War renderer: ${rendererBaseUrl}`,
  );
  console.log("Press Ctrl-C to stop.");
  if (
    aiLeagueClipCanaryRecord?.lifecycle === "armed" &&
    aiLeagueRunClips !== null &&
    aiLeagueClipCanaryValidatedSource !== null
  ) {
    const canaryService = aiLeagueRunClips;
    const canaryRecord = aiLeagueClipCanaryRecord;
    void (async () => {
      // Revalidate immediately before consuming the one shot. Claim is a
      // durable, exclusive transition and always precedes the sole request.
      const freshSource = await canaryService.resolveRetainedRunSource(
        canaryRecord.runKey,
      );
      const anchorTurn = premiereClipRepresentativeAnchorTurn(
        canaryRecord.bucket,
      );
      if (
        freshSource === null ||
        freshSource.sourceReplaySha256 !== canaryRecord.sourceReplaySha256 ||
        anchorTurn > freshSource.renderableThroughTurn
      ) {
        throw new Error("clip_canary_source_validation_failed_after_bind");
      }
      await validateFreshAiLeagueClipCanaryTarget({
        privateStateRoot: replayPremierePrivateStateRoot,
        runsRoot: runsRootDir,
        target: canaryRecord,
        archiveStore: replayPremiereArchiveStore,
      });
      await claimAiLeagueClipCanary({
        privateStateRoot: replayPremierePrivateStateRoot,
        expectedTarget: canaryRecord,
      });
      aiLeagueClipCanaryActionAuthorized = true;
      const status = await canaryService.requestRunClip({
        runKey: canaryRecord.runKey,
        anchorTurn,
        participantId: null,
      });
      // A cache hit has no render-complete callback; reuse the canonical
      // promoter explicitly after claim so it follows the same provenance path.
      if (status.state === "ready") {
        await replayPremiereArchivedClipPromoter.promoteRatedCoworldRunClip({
          runKey: canaryRecord.runKey,
          bucket: canaryRecord.bucket,
          sourceReplaySha256: canaryRecord.sourceReplaySha256,
          sourceFilePath: freshSource.filePath,
        });
      }
    })().catch((error: unknown) => {
      console.error(
        `[league-clips] canary one-shot failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
});

let shutdownStarted = false;
process.on("SIGINT", () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  runningChild?.kill("SIGINT");
  renderer?.kill("SIGINT");
  replayPremiereRevealAutoClip?.close();
  const serviceShutdown = Promise.allSettled([
    replayPremiereClips?.close() ?? Promise.resolve(),
    aiLeagueRunClips?.close() ?? Promise.resolve(),
    replayPremiereProduction?.service.close() ?? Promise.resolve(),
  ]).then((results) =>
    results.some((result) => result.status === "rejected") ? 1 : 0,
  );
  server.close(() => {
    void serviceShutdown.then((exitCode) => process.exit(exitCode));
  });
});

const PLANNED_RESTART_SHUTDOWN_WATCHDOG_MS = 12_000;
const CONTROLLED_OUTAGE_DRILL_SHUTDOWN_WATCHDOG_MS = 50_000;

function beginHttpShutdown(): Promise<void> {
  return new Promise((resolve, reject) => {
    // close() synchronously stops new accepts. Drop idle keep-alive sockets as
    // well, but let active writes finish instead of destroying them.
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeIdleConnections();
  });
}

function beginRestartShutdown(
  mode: "planned_restart" | "controlled_outage_drill",
): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const watchdogMs =
    mode === "controlled_outage_drill"
      ? CONTROLLED_OUTAGE_DRILL_SHUTDOWN_WATCHDOG_MS
      : PLANNED_RESTART_SHUTDOWN_WATCHDOG_MS;
  // Arm this before any asynchronous shutdown work: an event-store append or
  // active HTTP request must not leave a listener-dark process alive forever.
  const watchdog = setTimeout(() => {
    console.error(`ProxyWar ${mode} shutdown exceeded its hard deadline.`);
    process.exit(1);
  }, watchdogMs);
  watchdog.unref();

  // External unavailability is initiated before any outage-start event. That
  // ordering makes the durable event evidence of real downtime, not a proof-
  // only ledger fabrication.
  const httpShutdown = beginHttpShutdown();
  runningChild?.kill("SIGTERM");
  renderer?.kill("SIGTERM");
  replayPremiereRevealAutoClip?.close();
  const premiereShutdown = httpShutdown.then(() =>
    mode === "controlled_outage_drill"
      ? (replayPremiereProduction?.service.closeForControlledOutageDrill() ??
        Promise.resolve())
      : (replayPremiereProduction?.service.closeForPlannedRestart() ??
        Promise.resolve()),
  );
  void Promise.allSettled([
    httpShutdown,
    replayPremiereClips?.close() ?? Promise.resolve(),
    aiLeagueRunClips?.close() ?? Promise.resolve(),
    premiereShutdown,
  ]).then((results) => {
    clearTimeout(watchdog);
    process.exit(
      results.some((result) => result.status === "rejected") ? 1 : 0,
    );
  });
}

process.on("SIGTERM", () => beginRestartShutdown("planned_restart"));
process.on("SIGUSR2", () => beginRestartShutdown("controlled_outage_drill"));

function hasValidBetaSession(req: Request): boolean {
  const cookies = parseCookieHeader(req.headers.cookie);
  return verifyProxyWarBetaSessionToken({
    config: betaAccess,
    token: cookies[betaAccess.cookieName],
  });
}

async function loadPublicReadinessReport(
  hub?: Awaited<ReturnType<typeof loadAgentDemoHubModel>>,
): Promise<ProxyWarPublicReadinessReport> {
  const model =
    hub ??
    (await loadAgentDemoHubModel({
      runsRootDir,
      tournamentsRootDir,
      evaluationsRootDir,
      rendererBaseUrl,
      jobs: recentJobs(),
      nationsDir: nationsRootDir,
      houseAgentBrain,
      closedBeta: betaAccess.enabled
        ? { enabled: true, label: betaAccess.label }
        : undefined,
    }));
  return buildProxyWarPublicReadinessReport({
    beta: betaAccess,
    network: networkConfig,
    hub: model,
    runningJobID,
    queuedJobCount: queuedJobIDs.length,
    maxQueuedJobs,
    allowPrivateAgentEndpoints,
    adminEnabled: betaAdminEnabled,
    savedExternalEndpointHealth:
      await checkProxyWarActiveRosterExternalEndpoints(
        latestSavedExternalAgents(model.savedNations),
        {
          relaySessionExists: (sessionID) =>
            agentRelay.hasActiveSession(sessionID, relayActiveIdleMs),
        },
      ),
  });
}

function latestSavedExternalAgents(
  nations: Awaited<ReturnType<typeof loadAgentDemoHubModel>>["savedNations"],
) {
  return nations
    .filter(
      (nation) =>
        nation.provider?.provider === "external-http" ||
        nation.provider?.provider === "external-relay",
    )
    .slice(0, 1);
}

function inviteCodeFromBody(body: Record<string, unknown>): string {
  const value = body.inviteCode ?? body.code;
  return typeof value === "string" ? value : "";
}

function endpointLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid endpoint";
  }
}

function relaySessionLabel(relayBaseUrl: string, sessionID: string): string {
  try {
    const url = new URL(
      `/api/agent-relay/sessions/${encodeURIComponent(sessionID)}`,
      relayBaseUrl,
    );
    return url.toString();
  } catch {
    return `managed relay session ${sessionID}`;
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

async function restoreSavedRelaySessionIfPossible(
  sessionID: string,
  bearer: string | undefined,
): Promise<void> {
  if (
    agentRelay.hasSession(sessionID) ||
    bearer === undefined ||
    bearer === ""
  ) {
    return;
  }
  const nations = await listProxyWarNations(nationsRootDir);
  const saved = nations.find(
    (nation) =>
      nation.provider?.provider === "external-relay" &&
      nation.provider.sessionID === sessionID,
  );
  const provider = saved?.provider;
  if (saved === undefined || provider?.provider !== "external-relay") {
    return;
  }
  let savedToken: string | undefined;
  try {
    savedToken = resolveExternalAgentToken(provider);
  } catch {
    return;
  }
  if (savedToken === undefined || !sameSecretValue(savedToken, bearer)) {
    return;
  }
  agentRelay.restoreSession({
    sessionID,
    sessionToken: savedToken,
    agentName: saved.agentName,
    profile: saved.profile,
    relayBaseUrl: provider.relayBaseUrl,
  });
}

function sameSecretValue(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function sendRelayError(res: Response, error: unknown): void {
  if (error instanceof ExternalAgentRelayError) {
    res.status(error.statusCode).json({
      ok: false,
      error: error.message,
      code: error.code,
      ...(error.fix !== undefined ? { fix: error.fix } : {}),
    });
    return;
  }
  res.status(400).json({
    ok: false,
    error:
      error instanceof Error ? error.message : "invalid managed relay request",
  });
}

function publicOriginForRequest(req: Request): string {
  if (serverUrls.publicUrl !== null) {
    return serverUrls.publicUrl;
  }
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
  const host = forwardedHost ?? firstHeaderValue(req.headers.host) ?? "";
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const protocol =
    forwardedProto ??
    (host.startsWith("127.0.0.1") || host.startsWith("localhost")
      ? "http"
      : "https");
  if (host === "") {
    return serverUrls.localUrl;
  }
  return `${protocol}://${host}`.replace(/\/+$/, "");
}

function cleanRelayAgentName(value: unknown): string {
  if (typeof value !== "string") {
    return "Relay Frontier";
  }
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2) {
    return "Relay Frontier";
  }
  return cleaned.slice(0, 60);
}

function cleanRelayProfile(value: unknown): AgentStrategyProfile {
  return typeof value === "string" &&
    (agentStrategyProfiles as readonly string[]).includes(value)
    ? (value as AgentStrategyProfile)
    : "opportunistic";
}

function cleanRelayDoctrine(value: unknown): ProxyWarDoctrine {
  const doctrines = [
    "balanced",
    "economic",
    "fortress",
    "diplomatic",
    "pressure",
  ] as const;
  return typeof value === "string" &&
    doctrines.includes(value as ProxyWarDoctrine)
    ? (value as ProxyWarDoctrine)
    : "balanced";
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeRelayDecisionRequest(value: unknown): ExternalAgentRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalAgentRelayError(
      "Managed relay request body must be a JSON object.",
      400,
      "relay_request_invalid",
      "Post the canonical Proxy War decision request under request.",
    );
  }
  const request = value as Partial<ExternalAgentRequest>;
  if (request.protocolVersion !== "proxywar-agent-v1") {
    throw new ExternalAgentRelayError(
      "Managed relay request has the wrong protocolVersion.",
      400,
      "relay_protocol_invalid",
      "Use protocolVersion proxywar-agent-v1.",
    );
  }
  if (
    !Array.isArray(request.legalActions) ||
    request.legalActions.length === 0
  ) {
    throw new ExternalAgentRelayError(
      "Managed relay request must include legalActions.",
      400,
      "relay_legal_actions_missing",
      "Send the same legalActions array that the AgentBrain received.",
    );
  }
  return request as ExternalAgentRequest;
}

async function assertExternalEndpointInputAllowed(
  input: Record<string, unknown>,
): Promise<void> {
  if (
    typeof input.endpointUrl !== "string" ||
    input.endpointUrl.trim() === ""
  ) {
    return;
  }
  await assertExternalAgentEndpointAllowed(input.endpointUrl, {
    allowPrivateNetwork: allowPrivateAgentEndpoints,
  });
}

function returnToFromBody(body: Record<string, unknown>): string | null {
  const value = body.returnTo ?? body.next;
  return typeof value === "string" ? value : null;
}

function queryParam(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : null;
  }
  return typeof value === "string" ? value : null;
}

function enforceRateLimit(
  scope: string,
  limit: number,
  req: Request,
  res: Response,
): boolean {
  if (limit <= 0) {
    return true;
  }
  const result = rateLimiter.consume({
    scope,
    key: rateLimitKey(req),
    limit,
  });
  void persistRateLimitState();
  res.setHeader("X-RateLimit-Limit", String(result.limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  res.setHeader("X-RateLimit-Reset", new Date(result.resetAt).toISOString());
  if (result.allowed) {
    return true;
  }
  res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1_000)));
  res.status(429).json({
    error: "Too many Proxy War beta requests. Please wait and try again.",
  });
  return false;
}

function rateLimitKey(req: Request): string {
  const remoteAddress = req.socket.remoteAddress ?? req.ip ?? "";
  if (isLoopbackAddress(remoteAddress)) {
    const cfConnectingIP = firstHeaderValue(req.headers["cf-connecting-ip"]);
    if (cfConnectingIP !== null) return `cf:${cfConnectingIP}`;
    const forwardedFor = firstHeaderValue(req.headers["x-forwarded-for"]);
    if (forwardedFor !== null) {
      return `xff:${forwardedFor.split(",")[0]?.trim() ?? forwardedFor}`;
    }
  }
  return remoteAddress !== "" ? remoteAddress : (req.ip ?? "unknown");
}

// A managed-relay request is "trusted local" when it arrives directly over
// loopback with no forwarding headers — i.e. the in-process game subprocess
// (local/dev mode) or a local self-test, never a tunnelled external client.
// Such callers bypass the relay rate limit and concurrent-poll cap so the
// game's own decision traffic is never throttled. A loopback request that
// carries cf-connecting-ip / x-forwarded-for came through the public tunnel
// and is treated as external (the inverse of the forwarded branch above).
function isTrustedLocalRelayRequest(req: Request): boolean {
  const remoteAddress = req.socket.remoteAddress ?? req.ip ?? "";
  if (!isLoopbackAddress(remoteAddress)) {
    return false;
  }
  return (
    firstHeaderValue(req.headers["cf-connecting-ip"]) === null &&
    firstHeaderValue(req.headers["x-forwarded-for"]) === null
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const first = value[0]?.trim();
    return first === undefined || first === "" ? null : first;
  }
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

function isLoopbackAddress(value: string): boolean {
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "localhost"
  );
}

function rendererProxyPrefixes(): string[] {
  return ["/ai-league-replay", "/@fs", ...proxyWarPublicRendererAssetPrefixes];
}

function proxyRendererRequest(
  req: express.Request,
  res: express.Response,
): void {
  if (process.env.AI_LEAGUE_DEMO_RENDERER === "false") {
    res
      .status(503)
      .send("Proxy War renderer is not running for this demo server.");
    return;
  }
  if (!isLoopbackRendererBaseUrl(rendererBaseUrl)) {
    res
      .status(503)
      .send(
        "Proxy War renderer proxy is restricted to a loopback renderer URL.",
      );
    return;
  }
  if (betaAccess.enabled && req.originalUrl.startsWith("/@fs")) {
    res
      .status(404)
      .send("renderer file-system route is not exposed in beta mode");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).send("renderer proxy is read-only");
    return;
  }

  const target = new URL(req.originalUrl, rendererBaseUrl);
  const proxyReq = http.request(
    target,
    {
      method: req.method,
      headers: rendererProxyHeaders(req.headers, target.host),
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode ?? 502);
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined) {
          res.setHeader(name, value);
        }
      }
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (error) => {
    res.status(502).send(`Proxy War renderer is unavailable: ${error.message}`);
  });
  proxyReq.end();
}

function servePublicRunArtifact(
  req: express.Request,
  res: express.Response,
): void {
  const runID = stringParam(req.params.runID);
  const artifact = stringParam(req.params.artifact);
  const artifactAllowed =
    isProxyWarPublicRunArtifact(artifact) ||
    (runID === "league" && isProxyWarPublicLeagueArtifact(artifact));
  if (!isSafeProxyWarArtifactSegment(runID) || !artifactAllowed) {
    res.status(404).send("artifact not available");
    return;
  }
  const filePath = path.resolve(runsRootDir, runID, artifact);
  if (!isInsideRoot(filePath, runsRootDir)) {
    res.status(404).send("artifact not available");
    return;
  }
  if (runID === "league" && artifact === "index.html") {
    res.setHeader("Content-Security-Policy", leagueContentSecurityPolicy());
  }
  // Large run bundles (e.g. the multi-MB spectator-replay.json) are streamed;
  // a client that aborts mid-stream must not crash the process. See
  // sendPublicArtifactFile / finishArtifactResponse.
  sendPublicArtifactFile(req, res, filePath, "artifact not found");
}

function servePublicTournamentArtifact(
  req: express.Request,
  res: express.Response,
): void {
  const tournamentID = stringParam(req.params.tournamentID);
  const artifact = stringParam(req.params.artifact);
  if (
    !isSafeProxyWarArtifactSegment(tournamentID) ||
    !isProxyWarPublicTournamentArtifact(artifact)
  ) {
    res.status(404).send("artifact not available");
    return;
  }
  const filePath = path.resolve(tournamentsRootDir, tournamentID, artifact);
  if (!isInsideRoot(filePath, tournamentsRootDir)) {
    res.status(404).send("artifact not available");
    return;
  }
  sendPublicArtifactFile(req, res, filePath, "artifact not found");
}

function servePublicDoc(req: express.Request, res: express.Response): void {
  const artifact = stringParam(req.params.artifact);
  if (
    !isSafeProxyWarArtifactSegment(artifact) ||
    !isProxyWarPublicDoc(artifact)
  ) {
    res.status(404).send("doc not available");
    return;
  }
  sendPublicArtifactFile(
    req,
    res,
    path.join(docsRootDir, artifact),
    "doc not found",
  );
}

function serveProxyWarAgentBootstrapScript(
  req: express.Request,
  res: express.Response,
): void {
  res.setHeader("content-type", "text/x-shellscript; charset=utf-8");
  sendPublicArtifactFile(
    req,
    res,
    path.join(externalAgentExampleRootDir, "bootstrap.sh"),
    "bootstrap script not found",
  );
}

function servePublicExternalAgentExample(
  req: express.Request,
  res: express.Response,
): void {
  const artifact = stringParam(req.params.artifact);
  if (
    !isSafeProxyWarArtifactSegment(artifact) ||
    !isProxyWarPublicExternalAgentExample(artifact)
  ) {
    res.status(404).send("example not available");
    return;
  }
  sendPublicArtifactFile(
    req,
    res,
    path.join(externalAgentExampleRootDir, artifact),
    "example not found",
    { dotfiles: "allow" },
  );
}

function jobResponse(job: AgentDemoJobRecord): AgentDemoJobRecord & {
  replayUrl?: string;
  reportUrl?: string;
  tournamentUrl?: string;
  evaluationUrl?: string;
} {
  const links = jobArtifactLinks(job);
  if (!betaAccess.enabled) {
    return { ...job, ...links };
  }
  return {
    ...job,
    ...links,
    outputTail: "",
    errorSummary:
      job.errorSummary === undefined
        ? undefined
        : redactLocalPaths(job.errorSummary),
  };
}

function jobArtifactLinks(job: AgentDemoJobRecord): {
  replayUrl?: string;
  reportUrl?: string;
  tournamentUrl?: string;
  evaluationUrl?: string;
} {
  if (job.latestRunID !== undefined) {
    const runID = encodeURIComponent(job.latestRunID);
    return {
      replayUrl: `/proxywar-replay/${runID}`,
      reportUrl: `/runs/${runID}/match-report.md`,
    };
  }
  if (job.latestTournamentID !== undefined) {
    const tournamentID = encodeURIComponent(job.latestTournamentID);
    return {
      tournamentUrl: `/tournaments/${tournamentID}/tournament-report.md`,
    };
  }
  if (job.latestEvaluationID !== undefined) {
    const evaluationID = encodeURIComponent(job.latestEvaluationID);
    return {
      evaluationUrl: `/evaluations/${evaluationID}/evaluation-report.md`,
    };
  }
  return {};
}

function redactLocalPaths(value: string): string {
  return value.split(process.cwd()).join("[project]");
}

function isInsideRoot(filePath: string, rootDir: string): boolean {
  const relative = path.relative(path.resolve(rootDir), filePath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function stringParam(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

function isLoopbackRendererBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function rendererProxyHeaders(
  headers: express.Request["headers"],
  targetHost: string,
): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      lowerName === "authorization" ||
      lowerName === "cookie" ||
      lowerName === "connection" ||
      lowerName === "host" ||
      lowerName === "proxy-authorization" ||
      lowerName === "transfer-encoding" ||
      lowerName === "upgrade"
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  forwarded.host = targetHost;
  return forwarded;
}

function maybeStartRenderer(): ChildProcess | null {
  if (leagueWrapperOnly || process.env.AI_LEAGUE_DEMO_RENDERER === "false") {
    return null;
  }
  const child = spawn(
    localBin("vite"),
    [
      "--host",
      rendererListenHost,
      "--port",
      String(rendererPort),
      "--strictPort",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GAME_ENV: "dev",
        AI_LEAGUE_DEMO_HMR_DIRECT: "true",
        AI_LEAGUE_RENDERER_PORT: String(rendererPort),
        SKIP_BROWSER_OPEN: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.on("error", (error) => {
    console.error(`Proxy War renderer failed to start: ${error.message}`);
  });
  child.on("close", (code) => {
    if (code !== 0 && code !== null) {
      console.error(
        `Proxy War renderer exited with code ${code}. If port ${rendererPort} is already in use, the hub will link to the existing process at ${rendererBaseUrl}.`,
      );
    }
  });
  return child;
}

function startNextQueuedJob(): void {
  if (runningJobID !== null) {
    return;
  }
  const nextJobID = queuedJobIDs.shift();
  if (nextJobID === undefined) {
    return;
  }
  const job = jobs.get(nextJobID);
  if (job === undefined || job.status !== "queued") {
    startNextQueuedJob();
    return;
  }
  startJob(job);
}

function startJob(job: AgentDemoJobRecord): void {
  const command = buildAgentDemoJobCommand(job.request, {
    artifactID: job.artifactID,
  });
  job.status = "running";
  runningJobID = job.jobID;
  void persistJobs();

  const child = spawn(command.executable, command.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...command.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  runningChild = child;

  child.stdout.on("data", (chunk: Buffer) => appendOutput(job, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendOutput(job, chunk));
  child.on("error", (error) => {
    appendOutput(job, Buffer.from(`\n${error.message}\n`));
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.errorSummary = error.message;
    if (runningJobID === job.jobID) {
      runningJobID = null;
      runningChild = null;
    }
    void persistJobs().then(() => startNextQueuedJob());
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.completedAt = new Date().toISOString();
    if (runningJobID === job.jobID) {
      runningJobID = null;
      runningChild = null;
    }
    if (job.status === "failed") {
      void persistJobs().then(() => startNextQueuedJob());
      return;
    }
    if (code !== 0) {
      job.status = "failed";
      job.errorSummary = failureSummary(job.outputTail, code);
      void persistJobs().then(() => startNextQueuedJob());
      return;
    }
    void completeSuccessfulJob(job).then(() => startNextQueuedJob());
  });
}

function appendOutput(job: AgentDemoJobRecord, chunk: Buffer): void {
  job.outputTail = `${job.outputTail}${chunk.toString("utf8")}`.slice(-20_000);
  void persistJobs();
}

function enqueueProxyWarJob(
  request: AgentDemoJobRequest,
): { ok: true; job: AgentDemoJobRecord } | { ok: false; error: string } {
  if (runningJobID !== null && queuedJobIDs.length >= maxQueuedJobs) {
    return {
      ok: false,
      error:
        "The Proxy War demo queue is full. Wait for the current jobs to finish and try again.",
    };
  }
  const jobID = randomUUID();
  const artifactID = defaultArtifactID(request, jobID);
  const job: AgentDemoJobRecord = {
    jobID,
    artifactID,
    label: buildAgentDemoJobCommand(request, { artifactID }).label,
    request,
    status: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    outputTail: "",
  };
  jobs.set(jobID, job);
  queuedJobIDs.push(jobID);
  void persistJobs();
  startNextQueuedJob();
  return { ok: true, job };
}

function recentJobs(limit = 30): AgentDemoJobRecord[] {
  return [...jobs.values()]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}

async function readJobHistory(): Promise<AgentDemoJobRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(jobsPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isJobRecord);
  } catch {
    return [];
  }
}

async function persistJobs(): Promise<void> {
  await fs.mkdir(jobsRootDir, { recursive: true });
  await fs.writeFile(jobsPath, `${JSON.stringify(recentJobs(100), null, 2)}\n`);
}

async function readRateLimitState(): Promise<
  ProxyWarRateLimitSnapshot | undefined
> {
  try {
    return normalizeProxyWarRateLimitSnapshot(
      JSON.parse(await fs.readFile(rateLimitStatePath, "utf8")) as unknown,
    );
  } catch {
    return undefined;
  }
}

async function persistRateLimitState(): Promise<void> {
  await fs.mkdir(path.dirname(rateLimitStatePath), { recursive: true });
  await fs.writeFile(
    rateLimitStatePath,
    `${JSON.stringify(rateLimiter.snapshot(), null, 2)}\n`,
  );
}

async function enrichCompletedJob(job: AgentDemoJobRecord): Promise<void> {
  if (job.artifactID !== undefined) {
    const attached = await attachExactArtifact(job, job.artifactID);
    if (attached) {
      return;
    }
    job.latestRunID = undefined;
    job.latestTournamentID = undefined;
    job.latestEvaluationID = undefined;
    return;
  }
  const startedAt = Date.parse(job.startedAt);
  if (job.request.kind === "demo") {
    job.latestRunID = await latestArtifactID({
      rootDir: runsRootDir,
      summaryFile: "match-summary.json",
      idKey: "runID",
      after: startedAt,
    });
  } else if (job.request.kind === "tournament") {
    job.latestTournamentID = await latestArtifactID({
      rootDir: tournamentsRootDir,
      summaryFile: "tournament-summary.json",
      idKey: "tournamentID",
      after: startedAt,
    });
  } else {
    job.latestEvaluationID = await latestArtifactID({
      rootDir: evaluationsRootDir,
      summaryFile: "evaluation-summary.json",
      idKey: "evalID",
      after: startedAt,
    });
  }
}

async function attachExactArtifact(
  job: AgentDemoJobRecord,
  artifactID: string,
): Promise<boolean> {
  if (job.request.kind === "demo") {
    const runDir = path.join(runsRootDir, artifactID);
    const summary = await readJsonRecord(
      path.join(runDir, "match-summary.json"),
    );
    if (summary?.runID === artifactID) {
      const hasReplayRecord = await gameRecordFileIsRenderable(
        path.join(runDir, "game-record.json"),
      );
      const hasReplayData = await fileExists(
        path.join(runDir, "spectator-replay.json"),
      );
      if (!hasReplayRecord || !hasReplayData) {
        job.errorSummary = [
          "The match wrote a summary but did not write the replay artifacts needed for rendered gameplay.",
          !hasReplayRecord
            ? "Missing or unrenderable game-record.json (it may be a compacted stub written when the full record was too large)."
            : "",
          !hasReplayData ? "Missing spectator-replay.json." : "",
        ]
          .filter(Boolean)
          .join(" ");
        return false;
      }
      job.latestRunID = artifactID;
      return true;
    }
    return false;
  }
  if (job.request.kind === "tournament") {
    const summary = await readJsonRecord(
      path.join(tournamentsRootDir, artifactID, "tournament-summary.json"),
    );
    if (summary?.tournamentID === artifactID) {
      job.latestTournamentID = artifactID;
      return true;
    }
    return false;
  }
  const summary = await readJsonRecord(
    path.join(evaluationsRootDir, artifactID, "evaluation-summary.json"),
  );
  if (summary?.evalID === artifactID) {
    job.latestEvaluationID = artifactID;
    return true;
  }
  return false;
}

async function completeSuccessfulJob(job: AgentDemoJobRecord): Promise<void> {
  try {
    await enrichCompletedJob(job);
    const artifactID =
      job.request.kind === "demo"
        ? job.latestRunID
        : job.request.kind === "tournament"
          ? job.latestTournamentID
          : job.latestEvaluationID;
    if (artifactID === undefined) {
      job.status = "failed";
      job.errorSummary =
        job.errorSummary ??
        "The match process exited successfully, but the expected artifact was not found. Please run a new match.";
    } else {
      job.status = "completed";
    }
  } catch (error) {
    job.status = "failed";
    job.errorSummary =
      error instanceof Error
        ? error.message
        : "The match completed, but artifact lookup failed.";
  } finally {
    await persistJobs();
  }
}

async function latestArtifactID(input: {
  rootDir: string;
  summaryFile: string;
  idKey: string;
  after: number;
}): Promise<string | undefined> {
  try {
    const dirents = await fs.readdir(input.rootDir, { withFileTypes: true });
    const candidates = await Promise.all(
      dirents
        .filter((dirent) => dirent.isDirectory())
        .map(async (dirent) => {
          const summaryPath = path.join(
            input.rootDir,
            dirent.name,
            input.summaryFile,
          );
          const summary = await readJsonRecord(summaryPath);
          if (summary === null) return null;
          const completedAt = Date.parse(String(summary.completedAt ?? ""));
          if (Number.isNaN(completedAt) || completedAt + 5_000 < input.after) {
            return null;
          }
          return {
            id:
              typeof summary[input.idKey] === "string"
                ? summary[input.idKey]
                : dirent.name,
            completedAt,
          };
        }),
    );
    return candidates
      .filter(
        (candidate): candidate is { id: string; completedAt: number } =>
          candidate !== null,
      )
      .sort((a, b) => b.completedAt - a.completedAt)[0]?.id;
  } catch {
    return undefined;
  }
}

async function readJsonRecord(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function publicReplayRecordIsRenderable(
  filePath: string,
): Promise<boolean> {
  let fileStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    fileStat = await fs.stat(filePath);
  } catch {
    publicReplayRenderabilityCache.delete(filePath);
    return false;
  }
  if (!fileStat.isFile()) {
    publicReplayRenderabilityCache.delete(filePath);
    return false;
  }

  const fingerprint = [
    fileStat.dev,
    fileStat.ino,
    fileStat.size,
    fileStat.mtimeMs,
  ].join(":");
  const cached = publicReplayRenderabilityCache.get(filePath);
  if (cached?.fingerprint === fingerprint) {
    publicReplayRenderabilityCache.delete(filePath);
    publicReplayRenderabilityCache.set(filePath, cached);
    return cached.verdict;
  }

  if (
    !publicReplayRenderabilityCache.has(filePath) &&
    publicReplayRenderabilityCache.size >=
      publicReplayRenderabilityCacheMaxEntries
  ) {
    const oldest = publicReplayRenderabilityCache.keys().next().value;
    if (oldest !== undefined) {
      publicReplayRenderabilityCache.delete(oldest);
    }
  }

  const entry = {
    fingerprint,
    verdict: gameRecordFileIsRenderable(filePath),
  };
  publicReplayRenderabilityCache.set(filePath, entry);
  try {
    return await entry.verdict;
  } catch {
    if (publicReplayRenderabilityCache.get(filePath) === entry) {
      publicReplayRenderabilityCache.delete(filePath);
    }
    return false;
  }
}

/**
 * Full-replay-retention fix (2026-08-06): `runID` here is always the
 * route's own `publicRunKey` path segment. Fast path: if the live
 * `game-record.json` is already renderable, this never touches the
 * archive — zero added cost for the overwhelming common case. Only when
 * it's missing/invalid does this attempt ONE bounded, race-safe
 * restoration of the exact archived copy (see
 * `CoworldLeagueArtifactRetention.ts`'s `restoreArchivedGameRecord` for
 * the validated-path/atomic-rename contract) before re-checking
 * renderability. A restore failure (no archive, corrupt/oversized gzip,
 * or a genuine disk I/O error) is caught and treated exactly like "not
 * renderable" — never crashes the request, never fabricates a link.
 */
async function ensureRenderableGameRecordPath(
  runID: string,
  gameRecordPath: string,
): Promise<boolean> {
  if (await publicReplayRecordIsRenderable(gameRecordPath)) {
    return true;
  }
  try {
    const restoredPath = await restoreArchivedGameRecord({
      runsRootDir,
      summaryArchiveDir,
      publicRunKey: runID,
    });
    if (restoredPath === null) {
      return false;
    }
  } catch (error) {
    console.error(
      `Archived game-record restoration failed for ${runID}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  return publicReplayRecordIsRenderable(gameRecordPath);
}

function isJobRecord(value: unknown): value is AgentDemoJobRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<AgentDemoJobRecord>;
  return (
    typeof record.jobID === "string" &&
    typeof record.label === "string" &&
    (record.status === "queued" ||
      record.status === "running" ||
      record.status === "completed" ||
      record.status === "failed") &&
    typeof record.startedAt === "string" &&
    record.request !== undefined
  );
}

function resetInterruptedJobs(): number {
  let reset = 0;
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.errorSummary = "Demo server restarted before this job completed.";
      reset += 1;
    }
  }
  return reset;
}

function defaultArtifactID(
  request: AgentDemoJobRecord["request"],
  jobID: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${request.kind}-${request.scenario}-${request.brain}-${jobID.slice(
    0,
    8,
  )}`;
}

function failureSummary(outputTail: string, exitCode: number | null): string {
  const lines = outputTail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...lines]
    .reverse()
    .find((line) =>
      /^(Error|TypeError|RangeError|ReferenceError|SyntaxError):/.test(line),
    );
  const actionableLine =
    errorLine ??
    [...lines]
      .reverse()
      .find(
        (line) =>
          !line.startsWith("at ") &&
          !line.startsWith("Node.js ") &&
          !line.includes("/node_modules/"),
      );
  if (errorLine === undefined && exitCode !== null) {
    const exitReason =
      exitCode === 143
        ? "job was stopped before completion"
        : `job exited with code ${exitCode}`;
    return actionableLine === undefined
      ? exitReason
      : `${exitReason}; last log: ${actionableLine.slice(0, 360)}`;
  }
  return (
    actionableLine?.slice(0, 500) ?? "job exited without a clear error line"
  );
}

function localBin(name: string): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function leagueClipPublicReadAllowed(requestPath: string): boolean {
  const route = matchProxyWarLeagueClipReadPath(requestPath);
  if (route?.publicLeague !== true) return false;
  if (aiLeagueRunClipsEnabled && aiLeagueRunClips !== null) return true;
  return (
    aiLeagueRunClips !== null &&
    aiLeagueRunClips.allowsCanaryRead(route.runKey, route.bucket)
  );
}

function leagueClipPublicWriteAllowed(requestPath: string): boolean {
  return (
    aiLeagueRunClipsEnabled &&
    aiLeagueRunClips !== null &&
    matchProxyWarLeagueClipWritePath(requestPath)?.publicLeague === true
  );
}

function firstConfiguredEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** The exact CC BY-SA attribution + no-endorsement lines used in clip captions. */
async function loadReplayPremiereClipLicenseStrings(): Promise<{
  attribution: string;
  noEndorsement: string;
}> {
  const raw = JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "resources", "lang", "en.json"),
      "utf8",
    ),
  ) as { replay_premiere?: Record<string, unknown> };
  const attribution = raw.replay_premiere?.["asset_attribution"];
  const noEndorsement = raw.replay_premiere?.["no_endorsement"];
  if (typeof attribution !== "string" || typeof noEndorsement !== "string") {
    throw new Error(
      "resources/lang/en.json is missing replay_premiere.asset_attribution / .no_endorsement",
    );
  }
  return { attribution, noEndorsement };
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    process.env[name]?.trim().toLowerCase() ?? "",
  );
}
