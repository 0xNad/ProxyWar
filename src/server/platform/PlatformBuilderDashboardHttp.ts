/**
 * Season Zero activation prompt Phase 6, "Minimal Builder dashboard" +
 * "Post-match builder report". Both routes are read-only aggregations
 * over data this codebase ALREADY computes — `read-model.json` (rank,
 * rating, active version, reliability, score-over-time — all already
 * threshold-gated by `AgentStatsPipeline.ts`/`AgentTimeSeries.ts`), the
 * claim store, and the version-release store. Nothing here recomputes a
 * stat; it only assembles and scopes already-published numbers to the
 * caller's OWN verified agent(s).
 *
 * Deliberately does NOT read `resources/identity/*.json` directly for
 * agent/builder display fields — the read model is the exact same
 * projection every public page already renders, so a verified Builder's
 * own dashboard never disagrees with what a visitor sees on
 * `/agent/:slug`.
 */
import { promises as fs } from "node:fs";
import express, { type Request, type Response, type Router } from "express";
import type { PublicAgent, PublicMatch } from "../ProxyWarPublicReadModel";
import { readFeaturedMatchStore } from "../agents/FeaturedMatch";
import { requestSecurityHeaders } from "../replay-premiere/ReplayPremiereHttp";
import {
  findClaimsByAccount,
  readBuilderClaimStore,
} from "./PlatformBuilderClaimStore";
import type { PlatformAccountSecurity } from "./PlatformAccountSecurity";
import type { PlatformGithubIdentityLinkStore } from "./PlatformGithubIdentityLinkStore";
import { findReleasesByAccount, readVersionReleaseStore } from "./PlatformVersionReleaseStore";

export interface PlatformBuilderDashboardHttpOptions {
  readonly security: PlatformAccountSecurity;
  readonly claimStore: { readonly stateRoot: string };
  readonly releaseStore: { readonly stateRoot: string };
  readonly identityLinkStore: PlatformGithubIdentityLinkStore;
  /** Absolute filesystem path to the already-published `read-model.json` — same artifact `GET /ai-league-runs/league/read-model.json` serves statically; read fresh per request, same no-caching discipline `loadIdentityRegistrySnapshot` already uses. */
  readonly readModelFilePath: string;
  readonly featuredMatchStateRoot: string;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

function sendFailure(res: Response, status: number, code: string): void {
  res.status(status).json({ error: { code } });
}

interface MinimalReadModelBuilder {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string | null;
}

interface MinimalReadModel {
  readonly agents: readonly PublicAgent[];
  readonly matches: readonly PublicMatch[];
  readonly builders: readonly MinimalReadModelBuilder[];
}

async function loadReadModel(filePath: string): Promise<MinimalReadModel | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("agents" in parsed) ||
      !("matches" in parsed) ||
      !("builders" in parsed)
    ) {
      return null;
    }
    const candidate = parsed as { agents: unknown; matches: unknown; builders: unknown };
    if (
      !Array.isArray(candidate.agents) ||
      !Array.isArray(candidate.matches) ||
      !Array.isArray(candidate.builders)
    ) {
      return null;
    }
    return {
      agents: candidate.agents as PublicAgent[],
      matches: candidate.matches as PublicMatch[],
      builders: candidate.builders as MinimalReadModelBuilder[],
    };
  } catch {
    return null;
  }
}

/** Most recent match (by `completedAt`, nulls last) any of whose participants is `agentSlug` — same rule `AgentProfilePage.ts`'s `recentMatchesForAgent` uses, duplicated here rather than imported since that module is client-only. */
function latestMatchForAgentSlug(
  matches: readonly PublicMatch[],
  agentSlug: string,
): PublicMatch | null {
  const relevant = matches.filter((match) =>
    match.participants.some((participant) => participant.agentSlug === agentSlug),
  );
  relevant.sort((a, b) => {
    if (a.completedAt === null) return 1;
    if (b.completedAt === null) return -1;
    return b.completedAt.localeCompare(a.completedAt);
  });
  return relevant[0] ?? null;
}

/** Best-effort rating movement across one match: the nearest recorded score point at/after `completedAt` minus the nearest one strictly before it, from the SAME `timeSeries.score` points every public profile already renders — never a fabricated per-match delta. `null` whenever either bracketing point is missing (e.g. below the series' own sample threshold, or the match falls outside the recorded window). */
function ratingMovementAcrossMatch(
  agent: PublicAgent,
  completedAt: string | null,
): { readonly before: number; readonly after: number; readonly delta: number } | null {
  if (completedAt === null) return null;
  const points = agent.timeSeries.score?.points ?? [];
  let before: number | null = null;
  let after: number | null = null;
  for (const point of points) {
    if (point.recordedAt < completedAt) {
      before = point.score;
    } else {
      after ??= point.score;
    }
  }
  if (before === null || after === null) return null;
  return { before, after, delta: after - before };
}

async function findUpcomingFeaturedEvent(
  featuredMatchStateRoot: string,
  agentId: string,
): Promise<{ readonly scheduledAt: string } | null> {
  try {
    const store = await readFeaturedMatchStore(featuredMatchStateRoot);
    const upcoming = store.matches
      .filter(
        (match) =>
          match.lane === "premiere" &&
          (match.state === "scheduled" || match.state === "published") &&
          match.scheduledAt !== null &&
          match.participants.some((participant) => participant.agentId === agentId),
      )
      .sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""));
    const next = upcoming[0];
    return next === undefined || next.scheduledAt === null
      ? null
      : { scheduledAt: next.scheduledAt };
  } catch {
    // A dashboard summary never fails the whole request over the featured-
    // match store being briefly unavailable — "no upcoming event known" is
    // the honest degraded answer, not a 503.
    return null;
  }
}

export function createPlatformBuilderDashboardRouter(
  options: PlatformBuilderDashboardHttpOptions,
): Router {
  const router = express.Router();
  const logError = options.onOperatorError ?? ((): void => {});

  router.get(
    "/api/account/builder-dashboard",
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const bootstrap = options.security.bootstrapRead(
          requestSecurityHeaders(req),
        );
        if (bootstrap.setCookie !== null) res.setHeader("Set-Cookie", bootstrap.setCookie);
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            bootstrap.account.accountId,
          );
        const claimFile = await readBuilderClaimStore(options.claimStore.stateRoot);
        const ownClaims = findClaimsByAccount(claimFile, canonicalAccountId);
        const verifiedClaims = ownClaims.filter((claim) => claim.state === "verified");
        if (verifiedClaims.length === 0) {
          res.status(200).json({
            schemaVersion: 1,
            isVerifiedBuilder: false,
            builder: null,
            agents: [],
            pendingReleases: [],
            claims: ownClaims.map((claim) => ({
              id: claim.id,
              agentId: claim.agentId,
              state: claim.state,
              updatedAt: claim.updatedAt,
            })),
          });
          return;
        }
        const readModel = await loadReadModel(options.readModelFilePath);
        const releaseFile = await readVersionReleaseStore(options.releaseStore.stateRoot);
        const releases = findReleasesByAccount(releaseFile, canonicalAccountId);
        const agents = await Promise.all(
          verifiedClaims.map(async (claim) => {
            const publicAgent =
              readModel?.agents.find((candidate) => candidate.id === claim.agentId) ?? null;
            const latestMatch =
              publicAgent?.slug === null || publicAgent === null || readModel === null
                ? null
                : latestMatchForAgentSlug(readModel.matches, publicAgent.slug);
            const reliability = publicAgent?.stats?.career.fingerprint.reliability ?? null;
            const nextScheduledEvent = await findUpcomingFeaturedEvent(
              options.featuredMatchStateRoot,
              claim.agentId,
            );
            return {
              agentId: claim.agentId,
              slug: publicAgent?.slug ?? null,
              displayName: publicAgent?.displayName ?? claim.builderProfileDraft.displayName,
              rank: publicAgent?.standing?.rank ?? null,
              score: publicAgent?.standing?.score ?? null,
              activeVersionLabel: publicAgent?.activeVersion?.publicVersionLabel ?? null,
              degradedRate: reliability === null ? null : 1 - reliability.value,
              latestMatch:
                latestMatch === null
                  ? null
                  : {
                      matchId: latestMatch.matchId,
                      completedAt: latestMatch.completedAt,
                      watchHref: latestMatch.watchHref,
                      directorCutHref: latestMatch.fullRenderHref,
                    },
              nextScheduledEvent,
            };
          }),
        );
        const firstAgent = readModel?.agents.find(
          (candidate) => candidate.id === verifiedClaims[0].agentId,
        );
        const builder =
          firstAgent?.builderId === null || firstAgent === undefined
            ? null
            : (readModel?.builders.find((candidate) => candidate.id === firstAgent.builderId) ??
              null);
        res.status(200).json({
          schemaVersion: 1,
          isVerifiedBuilder: true,
          builder,
          agents,
          pendingReleases: releases.map((release) => ({
            id: release.id,
            agentId: release.agentId,
            versionLabel: release.versionLabel,
            status: release.status,
            createdAt: release.createdAt,
          })),
          claims: ownClaims.map((claim) => ({
            id: claim.id,
            agentId: claim.agentId,
            state: claim.state,
            updatedAt: claim.updatedAt,
          })),
        });
      } catch (error) {
        logError("platform_builder_dashboard_failed", error);
        sendFailure(res, 503, "PLATFORM_UNAVAILABLE");
      }
    },
  );

  /**
   * Post-match builder report — focused, per-agent, never generic coaching
   * copy (activation prompt's own instruction). Scoped to a match ONE of
   * the caller's own verified agents actually played in; never leaks any
   * other viewer's match.
   */
  router.get(
    "/api/account/builder-dashboard/matches/:matchId",
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      const matchId =
        typeof req.params.matchId === "string" ? req.params.matchId : "";
      try {
        const bootstrap = options.security.bootstrapRead(
          requestSecurityHeaders(req),
        );
        if (bootstrap.setCookie !== null) res.setHeader("Set-Cookie", bootstrap.setCookie);
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            bootstrap.account.accountId,
          );
        const claimFile = await readBuilderClaimStore(options.claimStore.stateRoot);
        const verifiedAgentIds = new Set(
          findClaimsByAccount(claimFile, canonicalAccountId)
            .filter((claim) => claim.state === "verified")
            .map((claim) => claim.agentId),
        );
        const readModel = await loadReadModel(options.readModelFilePath);
        if (readModel === null) {
          sendFailure(res, 503, "PLATFORM_UNAVAILABLE");
          return;
        }
        const match = readModel.matches.find((candidate) => candidate.matchId === matchId);
        if (match === undefined) {
          sendFailure(res, 404, "PLATFORM_MATCH_NOT_FOUND");
          return;
        }
        const ownAgent = readModel.agents.find(
          (agent) =>
            verifiedAgentIds.has(agent.id ?? "") &&
            match.participants.some((participant) => participant.agentSlug === agent.slug),
        );
        if (ownAgent === undefined) {
          sendFailure(res, 404, "PLATFORM_MATCH_NOT_FOUND");
          return;
        }
        const participant = match.participants.find(
          (candidate) => candidate.agentSlug === ownAgent.slug,
        );
        res.status(200).json({
          schemaVersion: 1,
          report: {
            matchId: match.matchId,
            completedAt: match.completedAt,
            map: match.map,
            result:
              participant === undefined
                ? null
                : { isWinner: participant.isWinner, isAlive: participant.isAlive },
            ratingMovement: ratingMovementAcrossMatch(ownAgent, match.completedAt),
            matchReliability:
              match.decisionCount === null || match.degradedCount === null
                ? null
                : {
                    decisionCount: match.decisionCount,
                    degradedCount: match.degradedCount,
                  },
            links: {
              watchHref: match.watchHref,
              directorCutHref: match.fullRenderHref,
            },
          },
        });
      } catch (error) {
        logError("platform_builder_match_report_failed", error);
        sendFailure(res, 503, "PLATFORM_UNAVAILABLE");
      }
    },
  );

  return router;
}
