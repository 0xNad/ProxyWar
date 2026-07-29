/**
 * The platform's server-to-server call to betting's
 * `GET /api/internal/accounts/:accountId/betting-profile` — the one
 * sanctioned door into `ReplayPremierePointsLedger` for a process that
 * runs wagering off (the platform never reads the ledger directly;
 * betting stays its sole writer AND its sole direct reader — see
 * `BettingProfileServiceAuth.ts`'s doc for the shared-token contract).
 *
 * Keyed by the platform's opaque `accountId`, NEVER a display name:
 * `PlatformAccountStore.setDisplayName` never enforces uniqueness, so two
 * linked accounts can share a display name, and a display name is a
 * self-asserted label, not an identifier. `accountId` is stable and
 * minted once at account creation — see
 * `BettingPlatformAccountLinkStore.getByPlatformAccountId`'s doc for the
 * full correction (this used to be a `:name` lookup that matched a
 * leaderboard row's free-text display name; that was unsound).
 *
 * Every failure mode — betting down, slow, unreachable, misconfigured,
 * returning garbage — resolves to `null`, NEVER a thrown error: a profile
 * page must still render its league half when betting can't be reached
 * (see the contract this implements: "degraded, never broken, never a
 * 500"). Callers that want a distinct "not linked" vs "couldn't ask" only
 * get `null` either way, by design — same as an ordinary DB miss, not a
 * caller-visible outage.
 */
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 3_000;

export interface BettingPlayerProfile {
  readonly lifetimePoints: number;
  readonly premieresTraded: number;
  readonly premieresWon: number;
  readonly rank: number;
  readonly totalRankedParticipants: number;
}

const profileSchema = z.object({
  lifetimePoints: z.number(),
  premieresTraded: z.number(),
  premieresWon: z.number(),
  rank: z.number(),
  totalRankedParticipants: z.number(),
});

const responseSchema = z.object({
  schemaVersion: z.literal(1),
  profile: profileSchema.nullable(),
});

/** Injectable so tests can stub betting without a real second server. */
export interface BettingProfileClient {
  fetchProfile(accountId: string): Promise<BettingPlayerProfile | null>;
}

export function createBettingProfileClient(
  bettingOrigin: string,
  token: string,
  fetchTimeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): BettingProfileClient {
  return {
    async fetchProfile(accountId) {
      try {
        const response = await fetchImpl(
          `${bettingOrigin}/api/internal/accounts/${encodeURIComponent(accountId)}/betting-profile`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(fetchTimeoutMs),
          },
        );
        if (!response.ok) return null;
        const body: unknown = await response.json().catch(() => null);
        const parsed = responseSchema.safeParse(body);
        return parsed.success ? parsed.data.profile : null;
      } catch (error) {
        console.error(
          `Betting profile lookup failed (degrading to no betting section): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }
    },
  };
}
