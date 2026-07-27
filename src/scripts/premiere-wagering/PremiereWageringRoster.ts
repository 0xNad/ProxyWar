/**
 * Pulls the CURRENT ACTIVE league roster — every active champion policy, no
 * sampling — so a premiere-wagering pre-simulation seats the whole league,
 * not a subset (operator directive: "pull the current roster and seat every
 * active policy").
 *
 * Read-only toward Softmax: only the same read verbs
 * `coworld-league-mirror.ts` already uses (`leagues`, `results`,
 * `memberships`), same `uvx coworld ... --json` invocation. This module
 * never mutates hosted state — that happens in
 * `generate-xp-request-episode.ts`, which consumes this roster.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseLeagueSummary,
  pickCompetitionDivision,
} from "../../server/agents/CoworldLeagueMirrorCore";

const execFileAsync = promisify(execFile);

export interface ActiveRosterSeat {
  readonly policyVersionId: string;
  readonly policyLabel: string;
  readonly playerId: string;
  readonly playerName: string | null;
}

export interface ActiveLeagueRoster {
  readonly leagueId: string;
  readonly divisionId: string;
  readonly divisionName: string;
  readonly seats: readonly ActiveRosterSeat[];
}

export class PremiereWageringRosterError extends Error {}

export type CoworldJsonInvoker = (args: string[]) => Promise<unknown>;

const READ_VERBS = new Set(["leagues", "results", "memberships"]);

/** Same read-only `uvx coworld <verb> ... --json` pattern as
 * `coworld-league-mirror.ts`'s `coworldJson` — duplicated rather than
 * imported because that function is module-private there. */
export const defaultCoworldJsonInvoker: CoworldJsonInvoker = async (args) => {
  const verb = args[0];
  if (!READ_VERBS.has(verb)) {
    throw new PremiereWageringRosterError(
      `refusing non-read coworld verb: ${verb}`,
    );
  }
  const { stdout } = await execFileAsync(
    "uvx",
    ["coworld", ...args, "--json"],
    { timeout: 180_000, maxBuffer: 128 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Every DISTINCT active, competing, champion policy in the division —
 * de-duplicated by `policyVersionId` (a policy can hold more than one
 * membership row, e.g. across nested rating carry-over) so the roster never
 * seats the same policy twice under two labels.
 */
function parseActiveRosterSeats(value: unknown): ActiveRosterSeat[] {
  const seatByPolicyVersionId = new Map<string, ActiveRosterSeat>();
  for (const entry of Array.isArray(value) ? value : []) {
    const membership = isRecord(entry) ? entry : null;
    const substatus = membership !== null ? asString(membership.substatus) : null;
    if (
      membership === null ||
      membership.status !== "competing" ||
      (substatus !== null && substatus !== "active") ||
      membership.is_champion !== true ||
      asString(membership.end_time) !== null
    ) {
      continue;
    }
    const policyVersion = isRecord(membership.policy_version)
      ? membership.policy_version
      : null;
    const player = isRecord(membership.player) ? membership.player : null;
    const policyVersionId = policyVersion !== null ? asString(policyVersion.id) : null;
    const policyLabel = policyVersion !== null ? asString(policyVersion.label) : null;
    const playerId =
      (policyVersion !== null ? asString(policyVersion.player_id) : null) ??
      (player !== null ? asString(player.id) : null);
    if (policyVersionId === null || policyLabel === null || playerId === null) {
      continue;
    }
    if (!seatByPolicyVersionId.has(policyVersionId)) {
      seatByPolicyVersionId.set(policyVersionId, {
        policyVersionId,
        policyLabel,
        playerId,
        playerName: player !== null ? asString(player.name) : null,
      });
    }
  }
  return [...seatByPolicyVersionId.values()].sort((a, b) =>
    a.policyVersionId.localeCompare(b.policyVersionId),
  );
}

/**
 * Resolves the league's competition division and returns every active
 * champion policy in it. Throws (never silently returns a partial roster) if
 * the league or division can't be resolved — an xp-request seating a
 * truncated roster is a product bug, not a degraded-but-fine cycle the way a
 * stale mirror sync is.
 */
export async function fetchActiveLeagueRoster(options: {
  readonly leagueId: string;
  readonly coworldJson?: CoworldJsonInvoker;
}): Promise<ActiveLeagueRoster> {
  const coworldJson = options.coworldJson ?? defaultCoworldJsonInvoker;
  const [leagueRaw, divisionsRaw] = await Promise.all([
    coworldJson(["leagues", options.leagueId]),
    coworldJson(["results", options.leagueId]),
  ]);
  const league = parseLeagueSummary(leagueRaw);
  if (league === null) {
    throw new PremiereWageringRosterError(
      `league ${options.leagueId} not found or unreadable`,
    );
  }
  const division = pickCompetitionDivision(divisionsRaw);
  if (division === null) {
    throw new PremiereWageringRosterError(
      `league ${options.leagueId} has no readable competition division`,
    );
  }
  const membershipsRaw = await coworldJson([
    "memberships",
    "-d",
    division.id,
    "--active-only",
    "--champions-only",
    "--limit",
    "1000",
  ]);
  const seats = parseActiveRosterSeats(membershipsRaw);
  if (seats.length === 0) {
    throw new PremiereWageringRosterError(
      `division ${division.id} has zero active champion policies — nothing to seat`,
    );
  }
  return {
    leagueId: league.id,
    divisionId: division.id,
    divisionName: division.name,
    seats,
  };
}
