import { spawn, type ChildProcess } from "child_process";
import { randomUUID, timingSafeEqual } from "crypto";
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
import {
  getAppShellContent,
  setHtmlNoCacheHeaders,
} from "../server/RenderHtml";
import {
  pointsMergerFor,
  ReplayPremiereIdentityLinkStore,
} from "../server/replay-premiere/points/ReplayPremiereIdentityLinkStore";
import {
  ReplayPremierePointsLedger,
  resolveReplayPremierePointsLedgerRoot,
} from "../server/replay-premiere/points/ReplayPremierePointsLedger";
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
import { premiereClipRepresentativeAnchorTurn } from "../server/replay-premiere/ReplayPremiereContracts";
import {
  ReplayPremiereError,
  toPublicReplayPremiereFailure,
} from "../server/replay-premiere/ReplayPremiereErrors";
import {
  createReplayPremiereGithubAuthRouter,
  createReplayPremiereGithubOAuthClient,
  resolveReplayPremiereGithubOAuthConfig,
} from "../server/replay-premiere/ReplayPremiereGithubAuth";
import { ReplayPremiereGuestSecurity } from "../server/replay-premiere/ReplayPremiereGuestSecurity";
import {
  createReplayPremiereRouter,
  formatReplayPremiereHttpOperatorError,
  ReplayPremiereHttpRegistry,
  requestSecurityHeaders,
} from "../server/replay-premiere/ReplayPremiereHttp";
import type { ReplayPremiereSettlementPointsRecorder } from "../server/replay-premiere/ReplayPremiereInteractions";
import { createReplayPremierePublicPageRouter } from "../server/replay-premiere/ReplayPremierePublicPage";
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
// GitHub identity links — beside the points ledger: same root, same atomic
// write-temp-then-rename conventions, its own file
// (`github-identity-links-v1.json`). NOT the premiere private state root —
// see `ReplayPremiereIdentityLinkStore`'s class doc.
export const replayPremiereIdentityLinkStore =
  await ReplayPremiereIdentityLinkStore.open(
    replayPremierePointsLedgerRoot,
    pointsMergerFor(replayPremierePointsLedger),
  );
// "Sign in with GitHub" is cleanly absent — no button client-side, no
// mounted route below — unless BOTH secrets are configured. See
// `resolveReplayPremiereGithubOAuthConfig` and `RUNBOOK.md` for the exact
// app-registration recipe.
const replayPremiereGithubOAuthConfig = await resolveReplayPremiereGithubOAuthConfig();
const replayPremiereGithubOAuthClient =
  replayPremiereGithubOAuthConfig === null
    ? null
    : createReplayPremiereGithubOAuthClient(replayPremiereGithubOAuthConfig);
// Wraps the raw ledger so a settlement always credits the CURRENT canonical
// identity, even from a browser whose guest cookie was merged away by a
// GitHub link completed on a different device. `resolveCanonicalParticipantId`
// is a local file lookup, never a GitHub call — this can never block,
// delay, or fail a trade because GitHub is unreachable (see
// `ReplayPremiereIdentityLinkStore`'s class doc: the identity provider is
// never in the path of a trade).
const replayPremierePointsRecorder: ReplayPremiereSettlementPointsRecorder = {
  async recordPremiereSettlement(premiereId, settlements) {
    const resolved = await Promise.all(
      settlements.map(async (settlement) => ({
        ...settlement,
        participantId:
          await replayPremiereIdentityLinkStore.resolveCanonicalParticipantId(
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
};
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
const MAX_DISPLAY_NAME_REQUEST_BYTES = 512;
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
/** Attaches verified GitHub identity (or `null`s, when unlinked) to leaderboard/viewer entries in one bulk lookup — never per-row. */
async function decoratePointsEntries<T extends { participantId: string }>(
  entries: readonly T[],
): Promise<
  Array<T & { githubLogin: string | null; githubAvatarUrl: string | null }>
> {
  const described = await replayPremiereIdentityLinkStore.describeMany(
    entries.map((entry) => entry.participantId),
  );
  return entries.map((entry) => {
    const link = described.get(entry.participantId);
    return {
      ...entry,
      githubLogin: link?.login ?? null,
      githubAvatarUrl: link?.avatarUrl ?? null,
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
    // Resolve through any GitHub-link merge first: a browser whose guest
    // cookie was merged away into a canonical identity still finds ITSELF
    // here — never an empty orphaned row (see `ReplayPremiereIdentityLinkStore`).
    const viewerParticipantId =
      await replayPremiereIdentityLinkStore.resolveCanonicalParticipantId(
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
// Route-level JSON parsing: these mount above the global express.json() (which
// has to stay below the premiere router), so req.body would otherwise be
// undefined and every submission would 400 as a malformed name.
app.post(
  "/api/premieres/points/display-name",
  express.json({ limit: "8kb" }),
  async (req, res) => {
    if (!pointsRoutesEnabled) {
      res.status(404).json({ error: { code: "PREMIERE_UNAVAILABLE" } });
      return;
    }
    try {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      const authorization = replayPremiereGuestSecurity.authorizeWrite(
        requestSecurityHeaders(req),
      );
      const body: unknown = req.body;
      const displayName =
        typeof body === "object" &&
        body !== null &&
        "displayName" in body &&
        typeof body.displayName === "string" &&
        body.displayName.length <= MAX_DISPLAY_NAME_REQUEST_BYTES
          ? body.displayName
          : null;
      if (displayName === null) {
        res.status(400).json({ error: { code: "PREMIERE_INVALID_REQUEST" } });
        return;
      }
      const canonicalParticipantId =
        await replayPremiereIdentityLinkStore.resolveCanonicalParticipantId(
          authorization.participant.participantId,
        );
      const entry = await replayPremierePointsLedger.setDisplayName(
        canonicalParticipantId,
        displayName,
      );
      const [decoratedEntry] = await decoratePointsEntries([entry]);
      res.status(200).json({ schemaVersion: 1, entry: decoratedEntry });
    } catch (error) {
      sendReplayPremiereFailure(res, error);
    }
  },
);
// "Sign in with GitHub" — mounted ONLY when both OAuth secrets are
// configured (see `resolveReplayPremiereGithubOAuthConfig`); unset means
// these three paths simply don't exist (no route, no button, no broken
// state) and fall through to `createReplayPremiereRouter`'s 404 below.
if (replayPremiereGithubOAuthClient !== null) {
  app.use(
    createReplayPremiereGithubAuthRouter({
      security: replayPremiereGuestSecurity,
      identityLinkStore: replayPremiereIdentityLinkStore,
      oauthClient: replayPremiereGithubOAuthClient,
      publicOrigin: replayPremierePublicOrigin,
      // "Current premiere" here matches /bet's own definition below
      // (the most recently registered id) — at most one premiere ever
      // has an open (unsettled) market at a time in this exhibition
      // loop, so there is nothing to reconcile across instances.
      resolveCurrentMarketIdentityGuard: () => {
        const currentPremiereId = replayPremiereHttpRegistry
          .premiereIds()
          .at(-1);
        if (currentPremiereId === undefined) return null;
        return replayPremiereHttpRegistry.get(currentPremiereId)?.interactions ?? null;
      },
      onOperatorError: (operatorCode, error) => {
        console.error(
          `GitHub sign-in ${operatorCode}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
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
    pageContentSecurityPolicy: proxyWarLeagueContentSecurityPolicy(),
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
    response
      .status(503)
      .type("text/plain")
      .send("No premiere is currently running.");
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
    pageContentSecurityPolicy: proxyWarLeagueContentSecurityPolicy(),
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
    if (req.method === "GET" || req.method === "HEAD") {
      const leagueClipRead = matchProxyWarLeagueClipReadPath(req.path);
      if (
        isProxyWarPublicLeaguePath(req.path) ||
        isProxyWarPublicPremiereReadPath(req.path) ||
        isProxyWarPublicPointsReadPath(req.path) ||
        isProxyWarPublicRendererAssetPath(req.path) ||
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
        res.status(404).send("AI league replay record not found.");
        return;
      }
      res.redirect("/league");
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
        isProxyWarPublicPointsWritePath(req.path)
      ) {
        next();
        return;
      }
    }
    res.status(404).send("not available in league wrapper mode");
  });
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

app.get("/league", (req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    proxyWarLeagueContentSecurityPolicy(),
  );
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
      res.setHeader(
        "Content-Security-Policy",
        proxyWarLeagueContentSecurityPolicy(),
      );
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
      res.status(404).send("AI league replay record not found.");
      return;
    }
    const runID = stringParam(req.params.runID);
    const gameRecordPath = path.resolve(runsRootDir, runID, "game-record.json");
    if (
      !isInsideRoot(gameRecordPath, runsRootDir) ||
      !(await publicReplayRecordIsRenderable(gameRecordPath))
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
      res.status(404).send("AI league replay record not found.");
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
      !(await publicReplayRecordIsRenderable(gameRecordPath))
    ) {
      res.status(404).send("AI league replay record not found.");
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
    res.setHeader(
      "Content-Security-Policy",
      proxyWarLeagueContentSecurityPolicy(),
    );
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
