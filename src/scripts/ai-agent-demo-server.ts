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
  renderProxyWarAgentStartHtml,
  renderProxyWarPublicHtml,
  renderAgentDemoHubHtml,
  renderProxyWarAdminHtml,
  renderProxyWarTesterDashboardHtml,
} from "../server/agents/AgentDemoHub";
import {
  buildAgentDemoJobCommand,
  proxyWarTesterSavedRosterJobDefaults,
  type AgentDemoJobRequest,
  type AgentDemoJobRecord,
  loadProxyWarHouseAgentBrain,
  normalizeAgentDemoJobRequest,
} from "../server/agents/AgentDemoServerJobs";
import {
  defaultProxyWarNationsDir,
  deleteProxyWarNation,
  listProxyWarNations,
  saveProxyWarNation,
  syncProxyWarActiveRoster,
} from "../server/agents/ProxyWarNationRegistry";
import type { ProxyWarDoctrine } from "../server/agents/ProxyWarNationRegistry";
import {
  ExternalAgentRelayError,
  ExternalAgentRelayStore,
} from "../server/agents/ExternalAgentRelay";
import type { ExternalAgentRequest } from "../server/agents/ExternalHttpAgentBrain";
import {
  agentStrategyProfiles,
  type AgentStrategyProfile,
} from "../server/agents/AgentTypes";
import {
  betaSessionCookieHeader,
  clearBetaSessionCookieHeader,
  createProxyWarBetaSessionToken,
  loadProxyWarBetaAccessConfig,
  normalizeProxyWarBetaReturnTo,
  normalizeProxyWarBetaFeedback,
  parseCookieHeader,
  renderProxyWarBetaLoginHtml,
  verifyProxyWarBetaInviteCode,
  verifyProxyWarBetaSessionToken,
} from "../server/agents/ProxyWarBetaAccess";
import {
  isProxyWarPublicDoc,
  isProxyWarPublicExternalAgentExample,
  isProxyWarPublicRunArtifact,
  isProxyWarPublicTournamentArtifact,
  isSafeProxyWarArtifactSegment,
} from "../server/agents/ProxyWarPublicArtifacts";
import {
  checkExternalAgentEndpoint,
  normalizeExternalAgentHealthCheckInput,
} from "../server/agents/ExternalAgentHealthCheck";
import { resolveExternalAgentToken } from "../server/agents/ExternalAgentSecrets";
import { assertExternalAgentEndpointAllowed } from "../server/agents/ExternalAgentNetworkPolicy";
import { gameRecordFileIsRenderable } from "../server/agents/AgentSpectatorReplay";
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
import {
  normalizeExternalAgentReplaySandboxInput,
  replayExternalAgentDecision,
} from "../server/agents/ExternalAgentReplaySandbox";
import {
  buildProxyWarDemoServerUrls,
  loadProxyWarDemoServerNetworkConfig,
} from "../server/agents/ProxyWarDemoServerConfig";
import {
  buildProxyWarPublicReadinessReport,
  type ProxyWarPublicReadinessReport,
} from "../server/agents/ProxyWarPublicReadiness";
import {
  normalizeProxyWarRateLimitSnapshot,
  ProxyWarRateLimiter,
  type ProxyWarRateLimitSnapshot,
} from "../server/agents/ProxyWarRateLimit";

const app = express();
const networkConfig = loadProxyWarDemoServerNetworkConfig();
const serverUrls = buildProxyWarDemoServerUrls(networkConfig);
const port = networkConfig.port;
const host = networkConfig.host;
const rendererPort = Number(process.env.AI_LEAGUE_RENDERER_PORT ?? "9000");
const rendererListenHost = process.env.AI_LEAGUE_RENDERER_HOST ?? "127.0.0.1";
const rendererBaseUrl =
  process.env.AI_LEAGUE_RENDERER_BASE_URL ?? `http://127.0.0.1:${rendererPort}`;
const runsRootDir = path.join(process.cwd(), "artifacts", "ai-league-runs");
const tournamentsRootDir = path.join(
  process.cwd(),
  "artifacts",
  "ai-league-tournaments",
);
const evaluationsRootDir = path.join(process.cwd(), "artifacts", "ai-league-evals");
const jobsRootDir = path.join(process.cwd(), "artifacts", "ai-league-demo-jobs");
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
const betaAccess = loadProxyWarBetaAccessConfig();
const betaFeedbackRootDir = path.join(
  process.cwd(),
  "artifacts",
  "proxywar",
  "beta-feedback",
);
const betaFeedbackPath = path.join(betaFeedbackRootDir, "feedback.jsonl");
const rateLimitStatePath = path.join(
  process.cwd(),
  "artifacts",
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
  jobs: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_JOBS"),
    12,
  ),
  nations: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_NATIONS"),
    30,
  ),
  externalCheck: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_EXTERNAL_CHECK"),
    60,
  ),
  feedback: positiveInt(
    firstConfiguredEnv("PROXYWAR_RATE_LIMIT_FEEDBACK"),
    30,
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
const interruptedJobsReset = resetInterruptedJobs();
if (interruptedJobsReset > 0) {
  await persistJobs();
}

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));
app.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
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
  try {
    await restoreSavedRelaySessionIfPossible(req.params.sessionID, bearerToken(req));
    const result = await agentRelay.poll({
      sessionID: req.params.sessionID,
      token: bearerToken(req),
      waitMs: optionalPositiveInt(queryParam(req.query.waitMs)),
    });
    res.json(result);
  } catch (error) {
    sendRelayError(res, error);
  }
});

app.post("/api/agent-relay/sessions/:sessionID/decisions", (req, res) => {
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
  try {
    await restoreSavedRelaySessionIfPossible(req.params.sessionID, bearerToken(req));
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
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Proxy War beta invite required" });
    return;
  }
  res.redirect(`/beta?next=${encodeURIComponent(req.originalUrl)}`);
});

if (betaAccess.enabled) {
  app.get("/docs/:artifact", servePublicDoc);
  app.get("/examples/external-agent/:artifact", servePublicExternalAgentExample);
  app.get("/runs/:runID/:artifact", servePublicRunArtifact);
  app.get("/ai-league-runs/:runID/:artifact", servePublicRunArtifact);
  app.get(
    "/tournaments/:tournamentID/:artifact",
    servePublicTournamentArtifact,
  );
} else {
  app.get("/docs/:artifact", servePublicDoc);
  app.get("/examples/external-agent/:artifact", servePublicExternalAgentExample);
  app.use("/runs", express.static(runsRootDir, { extensions: ["html"] }));
  app.use(
    "/ai-league-runs",
    express.static(runsRootDir, { extensions: ["html"] }),
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

for (const prefix of rendererProxyPrefixes()) {
  app.use(prefix, proxyRendererRequest);
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
    const latestRun = model.runs.find((run) => run.hasOpenFrontReplay) ?? model.runs[0];
    res.json({
      ok: true,
      queue: {
        running: runningJobID !== null,
        queuedJobCount: queuedJobIDs.length,
        maxQueuedJobs,
        activeJob: recentJobs().find(
          (job) => job.status === "running" || job.status === "queued",
        ) ?? null,
      },
      latestRun:
        latestRun === undefined
          ? null
          : {
              runID: latestRun.runID,
              replayUrl: latestRun.hasOpenFrontReplay
                ? `/openfront-replay/${encodeURIComponent(latestRun.runID)}`
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
              postSpawnNonHoldActionCount: latestRun.postSpawnNonHoldActionCount,
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
  if (!enforceRateLimit("external-agent-check", rateLimits.externalCheck, req, res)) {
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
          endpoint: relaySessionLabel(provider.relayBaseUrl, provider.sessionID),
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
    const request = normalizeAgentDemoJobRequest(req.body as Record<string, unknown>);
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
    res.status(error instanceof ProxyWarActiveRosterHealthError ? 422 : 400).json({
      ok: false,
      error: error instanceof Error ? error.message : "invalid job request",
      ...(error instanceof ProxyWarActiveRosterHealthError
        ? { health: error.report }
        : {}),
    });
  }
});

app.post("/api/nations", async (req, res) => {
  if (!enforceRateLimit("nations", rateLimits.nations, req, res)) {
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    await assertExternalEndpointInputAllowed(body);
    const result = await saveProxyWarNation(body, { nationsDir: nationsRootDir });
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
      ].filter(Boolean).join(" Fix: ");
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
          : `/openfront-replay/${encodeURIComponent(queued.job.latestRunID)}`,
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

app.get("/openfront-replay/:runID", (req, res) => {
  if (!isSafeProxyWarArtifactSegment(req.params.runID)) {
    res.status(404).send("AI league replay record not found.");
    return;
  }
  res.redirect(`/ai-league-replay/${encodeURIComponent(req.params.runID)}`);
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
  console.log(`Proxy War renderer: ${rendererBaseUrl}`);
  console.log("Press Ctrl-C to stop.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runningChild?.kill(signal);
    renderer?.kill(signal);
    server.close(() => process.exit(0));
  });
}

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
  if (agentRelay.hasSession(sessionID) || bearer === undefined || bearer === "") {
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
    error: error instanceof Error ? error.message : "invalid managed relay request",
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
  return typeof value === "string" && doctrines.includes(value as ProxyWarDoctrine)
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
  if (!Array.isArray(request.legalActions) || request.legalActions.length === 0) {
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
  if (typeof input.endpointUrl !== "string" || input.endpointUrl.trim() === "") {
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
  return [
    "/ai-league-replay",
    "/@vite",
    "/@id",
    "/@fs",
    "/src",
    "/node_modules",
    "/assets",
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
  ];
}

function proxyRendererRequest(
  req: express.Request,
  res: express.Response,
): void {
  if (process.env.AI_LEAGUE_DEMO_RENDERER === "false") {
    res.status(503).send("Proxy War renderer is not running for this demo server.");
    return;
  }
  if (!isLoopbackRendererBaseUrl(rendererBaseUrl)) {
    res
      .status(503)
      .send("Proxy War renderer proxy is restricted to a loopback renderer URL.");
    return;
  }
  if (betaAccess.enabled && req.originalUrl.startsWith("/@fs")) {
    res.status(404).send("renderer file-system route is not exposed in beta mode");
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
    res
      .status(502)
      .send(`Proxy War renderer is unavailable: ${error.message}`);
  });
  proxyReq.end();
}

function servePublicRunArtifact(
  req: express.Request,
  res: express.Response,
): void {
  const runID = stringParam(req.params.runID);
  const artifact = stringParam(req.params.artifact);
  if (
    !isSafeProxyWarArtifactSegment(runID) ||
    !isProxyWarPublicRunArtifact(artifact)
  ) {
    res.status(404).send("artifact not available");
    return;
  }
  const filePath = path.resolve(runsRootDir, runID, artifact);
  if (!isInsideRoot(filePath, runsRootDir)) {
    res.status(404).send("artifact not available");
    return;
  }
  res.sendFile(filePath, (error) => {
    if (error !== undefined) {
      res.status(404).send("artifact not found");
    }
  });
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
  res.sendFile(filePath, (error) => {
    if (error !== undefined) {
      res.status(404).send("artifact not found");
    }
  });
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
  res.sendFile(path.join(docsRootDir, artifact), (error) => {
    if (error !== undefined) {
      res.status(404).send("doc not found");
    }
  });
}

function serveProxyWarAgentBootstrapScript(
  _req: express.Request,
  res: express.Response,
): void {
  res.setHeader("content-type", "text/x-shellscript; charset=utf-8");
  res.sendFile(
    path.join(externalAgentExampleRootDir, "bootstrap.sh"),
    (error) => {
      if (error !== undefined) {
        res.status(404).send("bootstrap script not found");
      }
    },
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
  res.sendFile(
    path.join(externalAgentExampleRootDir, artifact),
    { dotfiles: "allow" },
    (error) => {
      if (error !== undefined) {
        res.status(404).send("example not found");
      }
    },
  );
}

function jobResponse(
  job: AgentDemoJobRecord,
): AgentDemoJobRecord & {
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
      replayUrl: `/openfront-replay/${runID}`,
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
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function stringParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
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
  if (process.env.AI_LEAGUE_DEMO_RENDERER === "false") {
    return null;
  }
  const child = spawn(localBin("vite"), [
    "--host",
    rendererListenHost,
    "--port",
    String(rendererPort),
    "--strictPort",
  ], {
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
  });
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
    const summary = await readJsonRecord(path.join(runDir, "match-summary.json"));
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
          const summaryPath = path.join(input.rootDir, dirent.name, input.summaryFile);
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
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
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

function firstConfiguredEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    process.env[name]?.trim().toLowerCase() ?? "",
  );
}
